/**
 * ChunkWriter — per-chunk PCM-to-WebM lifecycle + VAD gate + JobStore persistence.
 *
 * Architecture: §5 (ChunkWriter owns "open/close chunk files, write PCM
 * atomically, manage 2s overlap tail, emit `chunk_ready` events"), §7.11
 * (VAD), §11.1 (delete-after-success invariant).
 *
 * On-disk format:
 *   - During capture: each chunk writes raw int16 LE PCM to
 *     `<chunkId>.<source>.pcm`. No container header — bytes are exactly the
 *     samples from audio-process. PcmFileWriter is synchronous so any audio
 *     that hit disk is recoverable on crash.
 *   - At chunk close: WebmEncoder transcodes the `.pcm` → `<chunkId>.<source>.webm`
 *     (libopus 32 kbps mono, voip profile — V1-equivalent). The `.pcm` is
 *     unlinked on encode success; the chunks row's `file_path` points at the
 *     `.webm`. If encoding fails, the `.pcm` is left on disk and
 *     RecoveryService picks it up on next launch.
 *
 * Driven by two message streams:
 *   1. Orchestrator → `beginChunk` declares which chunk we're writing.
 *   2. audio-process → `appendPcm` per ~100 ms PCM frame; `closeChunk` finalizes.
 *
 * The "rolling 2 s overlap tail" lives inside the audio-process (`AudioGraph`).
 * ChunkWriter is stateless across chunks: each begin/close pair is self-contained.
 *
 * Output of `closeChunk` is one of two atomic DB outcomes:
 *   - VAD said skip (or duration floor) → insert chunks (state='completed') +
 *     transcripts (empty, provider='local_vad') in one txn, then unlink the
 *     `.pcm`. No encoding cost.
 *   - VAD said keep → encode `.pcm` → `.webm`, unlink `.pcm`, insert chunks
 *     (state='captured'); the UploadQueue picks it up on its next tick.
 */

import fs from 'node:fs';
import path from 'node:path';

import { evaluate as evaluateVad, type VadConfig } from '@core/audio/VadGate';
import { PcmFileWriter } from '@core/audio/PcmFileWriter';
import type { WebmEncoder } from '@core/audio/WebmEncoder';
import type { ChunkSource, JobStore } from '@core/storage/JobStore';
import type { Clock } from '@core/util/Clock';
import { type Logger, noopLogger } from '@core/observability/Logger';

/** 16 kHz mono int16 — must match the audio-process capture format. */
const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;

/**
 * Chunks shorter than this are short-circuited to the VAD-skip path, no
 * upload (or encode) attempted. The intent: a held-then-immediately-released
 * hotkey produces a few hundred ms of mic-warmup audio that nobody asked to
 * transcribe — uploading it just wastes 1-3 s on a Groq round-trip and
 * leaves the HUD spinning. 500 ms is well below any deliberate dictation
 * (single short words like "yes" take ~250-400 ms but are usually preceded
 * by an intentional hold pattern that exceeds this).
 */
const MIN_CHUNK_DURATION_FOR_UPLOAD_MS = 500;

export interface BeginChunkInput {
  readonly chunkId: string;
  readonly sessionId: string;
  readonly idx: number;
  readonly source: ChunkSource;
  readonly startMs: number;
  /** Always 2000 for meeting chunks N>=1; 0 for dictation + the first meeting chunk. */
  readonly overlapPrefixMs: number;
  readonly deviceBoundary: boolean;
  readonly sleepBoundary: boolean;
}

export interface CloseChunkInput {
  readonly chunkId: string;
  /** Σ s² from the audio-process Mixer (see §7.11). */
  readonly sumSquares: number;
  readonly sampleCount: number;
}

/** Snapshot returned to the caller (orchestrator) after closeChunk persists. */
export interface ClosedChunkSummary {
  readonly chunkId: string;
  readonly skipped: boolean;
  readonly bytes: number;
  readonly durationMs: number;
}

export class ChunkWriter {
  /** Active PCM writers keyed by chunkId. Usually only one entry at a time. */
  private readonly active = new Map<string, ActiveChunk>();

  /** Construct with the persistence + filesystem deps. The recordings dir must exist. */
  constructor(
    private readonly store: JobStore,
    private readonly clock: Clock,
    private readonly recordingsDir: string,
    private readonly vad: VadConfig,
    private readonly encoder: Pick<WebmEncoder, 'encode'>,
    private readonly logger: Logger = noopLogger,
  ) {}

  /**
   * Declare the start of a chunk. Creates the per-session subdirectory if needed,
   * opens the `.pcm` file. PCM frames arriving after this for `chunkId` are
   * appended via `appendPcm`.
   */
  beginChunk(input: BeginChunkInput): void {
    const sessionDir = path.join(this.recordingsDir, input.sessionId);
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const pcmPath = path.join(sessionDir, `${input.chunkId}.${input.source}.pcm`);
    const writer = new PcmFileWriter(pcmPath);
    writer.open();
    this.active.set(input.chunkId, { meta: input, writer, pcmPath });
  }

  /**
   * Append PCM bytes for a chunk. Silently no-ops if the chunkId isn't active
   * (e.g., a late frame after close); we never log this case because it's
   * expected during the close→open handover in meeting mode.
   */
  appendPcm(chunkId: string, pcm: Buffer): void {
    const a = this.active.get(chunkId);
    if (!a) return;
    a.writer.append(pcm);
  }

  /**
   * Finalize a chunk: close the PCM, derive duration from sampleCount, apply
   * the duration floor + VAD, then either:
   *   - skip path → persist completed + unlink the `.pcm` (no encode cost), or
   *   - normal path → encode `.pcm` → `.webm`, unlink `.pcm`, persist captured.
   *
   * Async because encoding spawns ffmpeg; the only caller
   * (RecordingOrchestrator.onChunkClosed) awaits it.
   */
  async closeChunk(input: CloseChunkInput): Promise<ClosedChunkSummary> {
    const a = this.active.get(input.chunkId);
    if (!a) {
      // Expected when the orchestrator's phantom-cancel path already aborted
      // this chunk locally — the audio-process's chunk_closed reply can land
      // seconds later for a chunk we've discarded. No persistence to do; just
      // surface as a synthetic "skipped" summary so the orchestrator's hook
      // sees a consistent shape.
      this.logger.debug('chunk_writer: closeChunk for unknown chunkId (already aborted)', {
        chunkId: input.chunkId,
      });
      return { chunkId: input.chunkId, skipped: true, bytes: 0, durationMs: 0 };
    }
    this.active.delete(input.chunkId);

    // Close the PCM writer first (fsync + close fd). bytes here is the raw
    // PCM byte count — useful for short-circuit + logging, NOT what we store
    // in chunks.bytes for an uploaded chunk (that's the WebM size).
    const { bytes: pcmBytes, filePath: pcmPath } = a.writer.close();

    // Duration is authoritative from audio-process's sampleCount. We do NOT
    // recompute from pcmBytes — they agree in steady state, but if there's
    // ever a mismatch the audio-process count is the source of truth (the
    // mixer counts emitted samples, including silence-fill).
    const durationMs = Math.round((input.sampleCount / SAMPLE_RATE) * 1000);
    // end_ms is derived from the actual duration, not the orchestrator's
    // schedule — that way a chunk_closed arriving after rotation/stop still
    // produces a correct `chunks.end_ms` row.
    const endMs = a.meta.startMs + durationMs;

    // Duration floor: chunks below the threshold (typically accidental
    // press-then-release) skip the upload pipeline outright. Saves the
    // 1-3 s Groq round-trip on audio that almost certainly contains no
    // meaningful speech, and frees the HUD's processing state instantly.
    if (durationMs < MIN_CHUNK_DURATION_FOR_UPLOAD_MS) {
      this.logger.info('chunk_writer: short-circuit skip (below duration floor)', {
        chunkId: input.chunkId,
        sessionId: a.meta.sessionId,
        durationMs,
        threshold: MIN_CHUNK_DURATION_FOR_UPLOAD_MS,
      });
      this.persistSkipped(a.meta, endMs, pcmPath, pcmBytes, durationMs);
      return { chunkId: input.chunkId, skipped: true, bytes: pcmBytes, durationMs };
    }

    const decision = evaluateVad(
      { sumSquares: input.sumSquares, sampleCount: input.sampleCount },
      this.vad,
    );

    this.logger.info('chunk_writer: closeChunk decision', {
      chunkId: input.chunkId,
      sessionId: a.meta.sessionId,
      durationMs,
      sampleCount: input.sampleCount,
      rmsDbfs: Math.round(decision.rmsDbfs),
      vadSkip: decision.skip,
      pcmBytes,
    });

    if (decision.skip) {
      // VAD path: persist as completed with an empty transcript, no encode.
      this.persistSkipped(a.meta, endMs, pcmPath, pcmBytes, durationMs);
      return { chunkId: input.chunkId, skipped: true, bytes: pcmBytes, durationMs };
    }

    // Normal path: encode .pcm → .webm. On encode failure leave the .pcm in
    // place and DO NOT insert a chunks row — RecoveryService's orphan-PCM
    // sweep handles it on next launch. The chunk effectively becomes
    // "pending recovery" rather than "permanently failed", which matches the
    // WAV-era behavior (any PCM on disk eventually gets transcribed).
    const webmPath = pcmPath.replace(/\.pcm$/, '.webm');
    let webmBytes: number;
    try {
      const r = await this.encoder.encode(pcmPath, webmPath);
      webmBytes = r.bytes;
    } catch (err) {
      this.logger.warn('chunk_writer: webm encode failed; leaving .pcm for recovery', {
        chunkId: input.chunkId,
        sessionId: a.meta.sessionId,
        pcmPath,
        message: err instanceof Error ? err.message : String(err),
      });
      // No row insert; pcm stays for next-launch recovery.
      return { chunkId: input.chunkId, skipped: false, bytes: 0, durationMs };
    }

    // Encode succeeded → unlink the .pcm. Best-effort: if unlink fails the
    // worst case is RecoveryService sees a stray .pcm with a sibling .webm
    // already in the DB and ignores it (parseChunkAudioName + getChunk check).
    try {
      fs.unlinkSync(pcmPath);
    } catch {
      /* best-effort */
    }

    this.store.insertChunk({
      id: a.meta.chunkId,
      session_id: a.meta.sessionId,
      idx: a.meta.idx,
      source: a.meta.source,
      file_path: webmPath,
      start_ms: a.meta.startMs,
      end_ms: endMs,
      overlap_prefix_ms: a.meta.overlapPrefixMs,
      duration_ms: durationMs,
      bytes: webmBytes,
      sha256: null,
      device_boundary: a.meta.deviceBoundary,
      sleep_boundary: a.meta.sleepBoundary,
    });

    this.logger.debug('chunk captured', {
      chunkId: a.meta.chunkId,
      sessionId: a.meta.sessionId,
      durationMs,
      pcmBytes,
      webmBytes,
    });
    return { chunkId: input.chunkId, skipped: false, bytes: webmBytes, durationMs };
  }

  /** Abort + clean up any active chunks (used on session error). */
  abortAll(): void {
    for (const [, a] of this.active) a.writer.abort();
    this.active.clear();
  }

  /**
   * Shutdown-path handling for in-flight chunks. Different from the WAV era:
   * we do NOT run ffmpeg during shutdown (Electron reaps utility subprocesses,
   * and a half-encoded .webm is unrecoverable). Instead we close the PCM fds
   * cleanly and leave the `.pcm` files on disk. RecoveryService's
   * orphan-PCM sweep encodes them on next launch and inserts the chunks rows.
   *
   * Returns the count of `.pcm` files left behind — used for telemetry/tests.
   */
  finalizeAllOnShutdown(): number {
    let leftBehind = 0;
    for (const [chunkId, a] of this.active) {
      try {
        const { bytes, filePath } = a.writer.close();
        if (bytes <= 0) {
          // Empty PCM file — chunk opened but no PCM arrived before shutdown.
          // Not worth recovering; delete it now.
          try {
            fs.unlinkSync(filePath);
          } catch {
            /* best-effort */
          }
          continue;
        }
        leftBehind++;
        this.logger.info('chunk_writer: left .pcm for next-launch recovery', {
          chunkId,
          sessionId: a.meta.sessionId,
          pcmBytes: bytes,
          pcmPath: filePath,
        });
      } catch (err) {
        this.logger.warn('chunk_writer: finalizeAllOnShutdown failed for chunk', {
          chunkId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.active.clear();
    return leftBehind;
  }

  /**
   * Discard a single in-progress chunk without persisting it: aborts the PCM
   * writer (closes the FD, unlinks the file) and removes the chunk from the
   * active map. Used by the orchestrator's phantom-cancel path when the user
   * released the hotkey so fast that we don't want a DB record at all. Safe
   * to call when the chunkId isn't active.
   */
  abortChunk(chunkId: string): void {
    const a = this.active.get(chunkId);
    if (!a) return;
    this.active.delete(chunkId);
    a.writer.abort();
  }

  /** Test helper: which chunkIds are currently mid-write. */
  get activeChunkIds(): string[] {
    return [...this.active.keys()];
  }

  /**
   * VAD-skip (or duration-floor) persistence: insert chunks + transcripts in
   * one txn (so the "completed implies transcripts row exists" invariant
   * holds), then unlink the `.pcm`. No WebM is written — skipped chunks
   * never reach the encoder.
   *
   * `bytes` here is the raw PCM byte count; we store it on the chunks row
   * mainly for diagnostics. The file referenced by `file_path` is the `.pcm`
   * we're about to delete — but on the skip path it's deleted in the
   * post-commit hook, after the chunks/transcripts row is durable.
   */
  private persistSkipped(
    meta: BeginChunkInput,
    endMs: number,
    pcmPath: string,
    pcmBytes: number,
    durationMs: number,
  ): void {
    this.store.insertChunk({
      id: meta.chunkId,
      session_id: meta.sessionId,
      idx: meta.idx,
      source: meta.source,
      file_path: pcmPath,
      start_ms: meta.startMs,
      end_ms: endMs,
      overlap_prefix_ms: meta.overlapPrefixMs,
      duration_ms: durationMs,
      bytes: pcmBytes,
      sha256: null,
      device_boundary: meta.deviceBoundary,
      sleep_boundary: meta.sleepBoundary,
    });
    this.store.recordChunkUploadStart(meta.chunkId);
    this.store.recordChunkSuccessAndComplete(
      {
        chunk_id: meta.chunkId,
        text: '',
        words_json: null,
        provider: 'local_vad',
        model: `rms_dbfs_${this.vad.silenceThresholdDbfs}`,
        language: null,
        confidence: null,
        clock_time_ms: null,
      },
      () => {
        try {
          fs.unlinkSync(pcmPath);
        } catch {
          /* RecoveryService picks up orphan completed files on next launch. */
        }
      },
    );
    this.logger.debug('chunk vad-skipped', {
      chunkId: meta.chunkId,
      sessionId: meta.sessionId,
      durationMs,
      pcmBytes,
    });
  }
}

interface ActiveChunk {
  readonly meta: BeginChunkInput;
  readonly writer: PcmFileWriter;
  readonly pcmPath: string;
}

// Re-exported for tests that want to assert on the byte/sample math.
export const _internals = { SAMPLE_RATE, BYTES_PER_SAMPLE, MIN_CHUNK_DURATION_FOR_UPLOAD_MS };
