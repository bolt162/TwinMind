/**
 * ChunkWriter — per-chunk WAV lifecycle + VAD gate + JobStore persistence.
 *
 * Architecture: §5 (ChunkWriter owns "open/close WAV files, write PCM
 * atomically, manage 2s overlap tail, emit `chunk_ready` events"), §7.11
 * (VAD), §11.1 (delete-after-success invariant).
 *
 * Driven by two message streams:
 *   1. Orchestrator → `beginChunk` declares which chunk we're writing.
 *   2. audio-process → `appendPcm` per ~100 ms PCM frame; `closeChunk` finalizes.
 *
 * The "rolling 2 s overlap tail" lives inside the audio-process (`AudioGraph`)
 * — the architecture used to put it here but the redesign moved capture out
 * of main, so the rolling buffer lives where the PCM is generated. ChunkWriter
 * is now stateless across chunks: each begin/close pair is self-contained.
 *
 * Output of `closeChunk` is one of two atomic DB outcomes:
 *   - VAD said skip → insert chunks (state='completed') + transcripts (empty,
 *     provider='local_vad') in one txn, then unlink the WAV.
 *   - VAD said keep → insert chunks (state='captured'); the UploadQueue picks
 *     it up on its next tick.
 */

import fs from 'node:fs';
import path from 'node:path';

import { evaluate as evaluateVad, type VadConfig } from '@core/audio/VadGate';
import { WavFileWriter } from '@core/audio/WavFileWriter';
import type { ChunkSource, JobStore } from '@core/storage/JobStore';
import type { Clock } from '@core/util/Clock';
import { type Logger, noopLogger } from '@core/observability/Logger';

/**
 * Chunks shorter than this are short-circuited to the VAD-skip path, no
 * upload attempted. The intent: a held-then-immediately-released hotkey
 * produces a few hundred ms of mic-warmup audio that nobody asked to
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
  /** Active WAV writers keyed by chunkId. Usually only one entry at a time. */
  private readonly active = new Map<string, ActiveChunk>();

  /** Construct with the persistence + filesystem deps. The recordings dir must exist. */
  constructor(
    private readonly store: JobStore,
    private readonly clock: Clock,
    private readonly recordingsDir: string,
    private readonly vad: VadConfig,
    private readonly logger: Logger = noopLogger,
  ) {}

  /**
   * Declare the start of a chunk. Creates the per-session subdirectory if needed,
   * opens the WAV file, writes the placeholder header. PCM frames arriving
   * after this for `chunkId` are appended via `appendPcm`.
   */
  beginChunk(input: BeginChunkInput): void {
    const sessionDir = path.join(this.recordingsDir, input.sessionId);
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const filePath = path.join(sessionDir, `${input.chunkId}.${input.source}.wav`);
    const writer = new WavFileWriter(filePath);
    writer.open();
    this.active.set(input.chunkId, { meta: input, writer, filePath });
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
   * Finalize a chunk: close the WAV, apply VAD, persist DB rows, optionally
   * delete the file on skip. Returns a summary so the orchestrator can push
   * a state update to the renderer.
   */
  closeChunk(input: CloseChunkInput): ClosedChunkSummary {
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

    const { bytes, dataBytes, durationMs, filePath } = a.writer.close();
    // end_ms is derived from the actual WAV duration, not the orchestrator's
    // schedule — that way a chunk_closed arriving after rotation/stop still
    // produces a correct `chunks.end_ms` row.
    const endMs = a.meta.startMs + durationMs;

    // Duration floor: chunks below the threshold (typically accidental
    // press-then-release) skip the upload pipeline outright. Saves the
    // 1-3 s Groq round-trip on audio that almost certainly contains no
    // meaningful speech, and frees the HUD's processing state instantly.
    if (durationMs < MIN_CHUNK_DURATION_FOR_UPLOAD_MS) {
      // Logged at info so we can see when the floor fires without flipping
      // log level. Drop to debug once the heuristic is tuned.
      this.logger.info('chunk_writer: short-circuit skip (below duration floor)', {
        chunkId: input.chunkId,
        sessionId: a.meta.sessionId,
        durationMs,
        threshold: MIN_CHUNK_DURATION_FOR_UPLOAD_MS,
      });
      this.persistSkipped(a.meta, endMs, filePath, dataBytes, durationMs, bytes);
      return { chunkId: input.chunkId, skipped: true, bytes, durationMs };
    }

    const decision = evaluateVad(
      { sumSquares: input.sumSquares, sampleCount: input.sampleCount },
      this.vad,
    );

    // Surface the actual WAV duration + VAD decision so we can see what's
    // happening for short hotkey presses. Info level for the same reason.
    this.logger.info('chunk_writer: closeChunk decision', {
      chunkId: input.chunkId,
      sessionId: a.meta.sessionId,
      durationMs,
      sampleCount: input.sampleCount,
      rmsDbfs: Math.round(decision.rmsDbfs),
      vadSkip: decision.skip,
      bytes,
    });

    if (decision.skip) {
      // VAD path: persist as completed with an empty transcript and unlink.
      this.persistSkipped(a.meta, endMs, filePath, dataBytes, durationMs, bytes);
      return { chunkId: input.chunkId, skipped: true, bytes, durationMs };
    }

    // Normal path: persist as captured; the UploadQueue picks it up on tick.
    this.store.insertChunk({
      id: a.meta.chunkId,
      session_id: a.meta.sessionId,
      idx: a.meta.idx,
      source: a.meta.source,
      file_path: filePath,
      start_ms: a.meta.startMs,
      end_ms: endMs,
      overlap_prefix_ms: a.meta.overlapPrefixMs,
      duration_ms: durationMs,
      bytes,
      sha256: null,
      device_boundary: a.meta.deviceBoundary,
      sleep_boundary: a.meta.sleepBoundary,
    });

    this.logger.debug('chunk captured', {
      chunkId: a.meta.chunkId,
      sessionId: a.meta.sessionId,
      durationMs,
      bytes,
    });
    return { chunkId: input.chunkId, skipped: false, bytes, durationMs };
  }

  /** Abort + clean up any active chunks (used on session error or shutdown). */
  abortAll(): void {
    for (const [, a] of this.active) a.writer.abort();
    this.active.clear();
  }

  /**
   * Discard a single in-progress chunk without persisting it: aborts the
   * WAV writer (closes the FD, unlinks the file) and removes the chunk
   * from the active map. Used by the orchestrator's phantom-cancel path
   * when the user released the hotkey so fast that we don't want a DB
   * record at all. Safe to call when the chunkId isn't active.
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
   * VAD-skip persistence: insert chunks + transcripts in one txn (so the
   * "completed implies transcripts row exists" invariant holds) then unlink
   * the WAV. Uses a sequence of CAS-style writes guarded inside JobStore.
   */
  private persistSkipped(
    meta: BeginChunkInput,
    endMs: number,
    filePath: string,
    dataBytes: number,
    durationMs: number,
    bytes: number,
  ): void {
    // Step 1: insert the chunk row as captured.
    this.store.insertChunk({
      id: meta.chunkId,
      session_id: meta.sessionId,
      idx: meta.idx,
      source: meta.source,
      file_path: filePath,
      start_ms: meta.startMs,
      end_ms: endMs,
      overlap_prefix_ms: meta.overlapPrefixMs,
      duration_ms: durationMs,
      bytes,
      sha256: null,
      device_boundary: meta.deviceBoundary,
      sleep_boundary: meta.sleepBoundary,
    });
    // Step 2: synthesize the upload + completion pair so we keep the FSM
    // invariants intact (captured → uploading → transcribed → completed),
    // with an empty transcript carrying provider='local_vad' (see §7.11).
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
      },
      () => {
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* RecoveryService picks up orphan completed files on next launch. */
        }
      },
    );
    this.logger.debug('chunk vad-skipped', {
      chunkId: meta.chunkId,
      sessionId: meta.sessionId,
      durationMs,
      dataBytes,
    });
  }
}

interface ActiveChunk {
  readonly meta: BeginChunkInput;
  readonly writer: WavFileWriter;
  readonly filePath: string;
}
