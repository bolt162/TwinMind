/**
 * RecoveryService — runs on every app launch to reconcile DB + filesystem.
 *
 * Architecture: §7.8 (crash recovery for audio), §11.5 (corrupted-state table),
 * §11.7 (retention sweep), §7.10 (sleep timeout auto-end).
 *
 * Handled cases (rows from the §11.5 table marked ✓):
 *   ✓ uploading > staleUploadingMs → reset to captured
 *   ✓ completed + file exists → delete file
 *   ✓ row exists + file missing (file_deleted_at NULL) → mark failed_permanent (file_lost)
 *   ✓ sessions.status='paused_by_sleep' > sleepTimeoutMs → end with reason='sleep_timeout'
 *   ✓ retention sweep: failed_permanent + file_deleted_at NULL + updated_at < threshold
 *
 * Audio-file recovery (post-WAV→WebM migration):
 *   - Orphan `.pcm`: in-flight at crash; encode to `.webm`, insert chunks row.
 *   - Orphan `.webm`: encode succeeded but DB insert lost to a crash; probe
 *     duration from the container and insert a chunks row.
 *   - Legacy `.wav` shim: previous-build WAVs left over from before the
 *     migration; re-encode to `.webm` so the upload queue can transcribe
 *     them. Removed one release after migration ships.
 *
 * Deferred (no evidence yet that these cases occur in practice — add when seen):
 *   - transcribed but no transcripts row (impossible if the success txn worked)
 *   - file exists, no row → reconstruct row from filename (handled per-extension below)
 *   - same chunk twice in DB and on disk
 *
 * Pure in spirit: takes the dependencies it needs and emits a report; no
 * background timers, no listeners. The composition root calls `recover()` once
 * at startup and schedules a daily retention sweep on top.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { WebmEncoder } from '@core/audio/WebmEncoder';
import { resolveFfmpegPath } from '@core/audio/WebmEncoder';
import type { ChunkSource, JobStore } from '@core/storage/JobStore';
import type { Clock } from '@core/util/Clock';
import { type Logger, noopLogger } from '@core/observability/Logger';

// PCM format constants — must match audio-process capture (16 kHz mono int16).
// Used to derive a `.pcm` file's duration from its byte count.
const PCM_BYTES_PER_SECOND = 16_000 * 1 * 2; // sample_rate * channels * bytes/sample
const VALID_CHUNK_SOURCES: readonly ChunkSource[] = ['mic', 'mixed'];

// Legacy WAV constants — only used by the one-release shim that re-encodes
// pre-migration `.wav` files. Remove this block when the shim retires.
const LEGACY_WAV_HEADER_BYTES = 44;
const LEGACY_WAV_BYTES_PER_SECOND = 16_000 * 1 * 2;

export interface RecoveryOptions {
  /**
   * §11.5: age threshold (ms) for resetting 'uploading' rows back to
   * 'captured'. Default 0 — at startup we reset EVERY 'uploading' row
   * regardless of age, because the upload queue hasn't started yet so
   * there cannot be any healthy live uploads. Anything stuck in
   * 'uploading' at startup is by definition orphaned by the previous
   * process (crash or hard quit).
   *
   * The previous default (10 minutes) was a paranoid guard against a
   * scenario that physically cannot happen at startup, and it caused a
   * concrete bug: a session that crashed mid-upload + relaunched fast
   * (within 10 min) left the in-flight chunk permanently stuck in
   * 'uploading', which made `sessionHasInFlightChunks` perpetually true,
   * which made `fireSummary` silently skip — manual "Generate Summary"
   * clicks did nothing.
   *
   * Field is kept (not removed) so tests can inject a non-zero threshold
   * if they need to verify the age gate works.
   */
  readonly staleUploadingMs: number;
  /** §7.10: paused_by_sleep sessions older than this → auto-end. Default 30 min. */
  readonly sleepTimeoutMs: number;
  /** §11.7: failed_permanent audio files older than this → delete. Default 30 days. */
  readonly retentionMs: number;
}

export const DEFAULT_RECOVERY_OPTIONS: RecoveryOptions = {
  staleUploadingMs: 0,
  sleepTimeoutMs: 30 * 60 * 1000,
  retentionMs: 30 * 24 * 60 * 60 * 1000,
};

export interface RecoveryReport {
  staleSleepSessions: number;
  resetUploading: number;
  orphanCompletedFilesDeleted: number;
  rowsMarkedFileLost: number;
  retentionFilesDeleted: number;
  /**
   * Sessions whose summary call was in flight (`summary_status='pending'`)
   * when the app last quit/crashed. Flipped to `'failed'` so the UI shows
   * "Generate summary" (manual retry).
   */
  staleSummaryPending: number;
  /**
   * Sessions still in `status='active'` at startup — orphaned recordings
   * from a prior process that crashed / was force-quit mid-record.
   * Force-ended with `end_reason='crash_recovered'`.
   */
  crashRecoveredActive: number;
  /**
   * Sessions stuck in `status='paused_by_device_loss'` at startup. The
   * orchestrator's `pendingResume` is in-memory only, so these can't be
   * resumed across restarts. Force-ended with `device_lost_unresumed`.
   */
  unresumedDeviceLoss: number;
  /**
   * `.pcm` files in `recordings/<sessionId>/` with no matching `chunks` row.
   * Happens when the app is force-quit mid-record before the in-flight
   * chunk's `chunk_closed` reply arrives from the audio-process (or before
   * `ChunkWriter.closeChunk` finished encoding). Recovery encodes them to
   * `.webm` and inserts captured rows so the upload queue transcribes them.
   */
  recoveredOrphanPcms: number;
  /**
   * `.webm` files in `recordings/<sessionId>/` with no matching `chunks` row.
   * Happens when ChunkWriter encoded successfully but a crash landed between
   * the encode and the DB insert. Recovery probes duration via ffmpeg and
   * inserts a captured row.
   */
  recoveredOrphanWebms: number;
  /**
   * Pre-migration `.wav` files left over from a build that wrote WAV chunks.
   * Re-encoded to `.webm` and a captured row inserted. Remove the shim one
   * release after the migration ships.
   */
  recoveredLegacyWavs: number;
}

export class RecoveryService {
  /**
   * Configure with the store, clock, and recovery thresholds.
   * `recordingsDir` is required for orphan-audio sweeps; pass `null` in unit
   * tests that don't touch the filesystem. `encoder` is required when
   * `recordingsDir` is non-null because orphan `.pcm` / legacy `.wav` are
   * re-encoded to `.webm`; pass `null` to skip those passes in tests.
   */
  constructor(
    private readonly store: JobStore,
    private readonly clock: Clock,
    private readonly recordingsDir: string | null,
    private readonly options: RecoveryOptions = DEFAULT_RECOVERY_OPTIONS,
    private readonly logger: Logger = noopLogger,
    private readonly encoder: Pick<WebmEncoder, 'encode'> | null = null,
  ) {}

  /**
   * Run all enabled recovery passes in order; returns the count summary the
   * UI uses to show the "Recovered an interrupted recording" banner.
   *
   * Async because orphan-PCM and legacy-WAV recovery encode via ffmpeg.
   */
  async recover(): Promise<RecoveryReport> {
    const report: RecoveryReport = {
      staleSleepSessions: 0,
      resetUploading: 0,
      orphanCompletedFilesDeleted: 0,
      rowsMarkedFileLost: 0,
      retentionFilesDeleted: 0,
      staleSummaryPending: 0,
      crashRecoveredActive: 0,
      unresumedDeviceLoss: 0,
      recoveredOrphanPcms: 0,
      recoveredOrphanWebms: 0,
      recoveredLegacyWavs: 0,
    };

    // 0. Crash recovery first so subsequent sweeps see consistent session state.
    report.crashRecoveredActive = this.store.autoEndCrashRecoveredActive();
    report.unresumedDeviceLoss = this.store.autoEndUnresumedDeviceLoss();

    // 1. Sleep timeout — sessions paused by sleep too long ago auto-end.
    report.staleSleepSessions = this.store.autoEndStaleSleepPaused(
      this.clock.now(),
      this.options.sleepTimeoutMs,
    );

    // 2. Stuck uploading → captured so the queue picks them up again.
    report.resetUploading = this.store.resetStuckUploading(this.options.staleUploadingMs);

    // 3. completed + file still present → delete file.
    for (const c of this.store.findCompletedRows()) {
      if (fileExists(c.file_path)) {
        tryUnlink(c.file_path);
        report.orphanCompletedFilesDeleted++;
      }
    }

    // 4. Row points at a missing file and we haven't deleted it on purpose →
    //    mark failed_permanent with reason='file_lost'.
    for (const c of this.store.findChunksForFileCheck()) {
      if (!fileExists(c.file_path)) {
        this.store.markChunkFileLost(c.id);
        report.rowsMarkedFileLost++;
      }
    }

    // 5. Stale summary 'pending' → 'failed'.
    report.staleSummaryPending = this.store.recoverStaleSummaryPending();

    // 6. Retention sweep: failed_permanent files aged past the horizon.
    const due = this.store.findFailedPermanentDueForRetention(this.options.retentionMs);
    const now = this.clock.now();
    for (const c of due) {
      tryUnlink(c.file_path);
      this.store.markChunkFileDeleted(c.id, now);
      report.retentionFilesDeleted++;
    }

    // 7. Orphan-audio sweep: walks recordings/<sessionId>/ once per session,
    //    handles `.pcm` / `.webm` / `.wav` (legacy) for any file without a
    //    matching chunks row. Sequential encoding keeps disk + CPU bounded.
    if (this.recordingsDir !== null) {
      await this.recoverOrphanAudioFiles(this.recordingsDir, report);
    }

    this.logger.info('recovery completed', { ...report });
    return report;
  }

  /**
   * Walk `recordings/<sessionId>/` and reconcile every orphan audio file
   * (one without a matching chunks row). Sequential — encoding several
   * orphans in parallel would burn CPU during a sensitive launch window.
   * Each file lands in one of three buckets:
   *   - `.pcm`  → encode to `.webm`, unlink `.pcm`, insert row
   *   - `.webm` → probe duration, insert row
   *   - `.wav`  → legacy: re-encode header-stripped PCM body to `.webm`,
   *               unlink `.wav`, insert row (one-release shim)
   * Anything else is left untouched.
   */
  private async recoverOrphanAudioFiles(
    recordingsDir: string,
    report: RecoveryReport,
  ): Promise<void> {
    let sessionDirs: string[];
    try {
      sessionDirs = fs.readdirSync(recordingsDir);
    } catch {
      // recordings/ doesn't exist yet (fresh install, never recorded). Fine.
      return;
    }

    for (const sessionId of sessionDirs) {
      const sessionDir = path.join(recordingsDir, sessionId);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(sessionDir, { withFileTypes: true });
      } catch {
        continue;
      }
      // Skip directories that don't correspond to known sessions — those
      // are residue from a deleted session and reviving them would
      // resurrect data the user explicitly removed.
      const session = this.store.getSession(sessionId);
      if (!session) continue;

      // Snapshot existing chunks once per session so we can chain the
      // orphans after whatever was already persisted.
      const existing = this.store.listChunksForSession(sessionId);
      let maxIdx = existing.reduce((acc, c) => Math.max(acc, c.idx), -1);
      let lastEndMs = existing.reduce((acc, c) => Math.max(acc, c.end_ms), 0);

      // Order orphan candidates by file mtime ASCENDING so they're processed
      // in capture chronology. Without this we walk `readdirSync` order —
      // filesystem-defined (typically alphabetical by random-UUID chunkId)
      // — which is uncorrelated with when each PCM was actually written.
      // The downstream chaining (idx + start_ms = lastEndMs + duration)
      // depends on chronological order to produce a sensible transcript;
      // get it wrong and a meeting that crashed mid-rotation comes back
      // with chunks displayed in random order. mtime is sub-millisecond
      // on APFS and the audio process writes PCMs ~30 s apart, so two
      // orphans can never collide.
      const orphanCandidates: Array<{ entry: fs.Dirent; mtimeMs: number }> = [];
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!parseChunkAudioName(entry.name)) continue;
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(path.join(sessionDir, entry.name)).mtimeMs;
        } catch {
          // Unreadable stat → treat as oldest so it still gets a chance.
        }
        orphanCandidates.push({ entry, mtimeMs });
      }
      orphanCandidates.sort((a, b) => a.mtimeMs - b.mtimeMs);

      for (const { entry } of orphanCandidates) {
        const parsed = parseChunkAudioName(entry.name);
        if (!parsed) continue; // unreachable — filtered above; keeps types narrow
        if (this.store.getChunk(parsed.chunkId)) continue; // already reconciled

        const filePath = path.join(sessionDir, entry.name);
        const result = await this.reconcileOrphan(sessionId, filePath, parsed);
        if (!result) continue;

        maxIdx += 1;
        const startMs = lastEndMs;
        const endMs = startMs + result.durationMs;
        try {
          this.store.insertChunk({
            id: parsed.chunkId,
            session_id: sessionId,
            idx: maxIdx,
            source: parsed.source,
            file_path: result.webmPath,
            start_ms: startMs,
            end_ms: endMs,
            overlap_prefix_ms: 0,
            duration_ms: result.durationMs,
            bytes: result.bytes,
            sha256: null,
            device_boundary: false,
            sleep_boundary: false,
          });
          lastEndMs = endMs;
          report[result.bucket]++;
          this.logger.info('recovery: orphan audio reconstructed', {
            sessionId,
            chunkId: parsed.chunkId,
            source: parsed.source,
            ext: parsed.ext,
            durationMs: result.durationMs,
            bytes: result.bytes,
          });
        } catch (err) {
          this.logger.warn('recovery: orphan audio insertChunk failed', {
            sessionId,
            chunkId: parsed.chunkId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  /**
   * Per-file dispatch: do whatever's needed to land an orphan in the form
   * the chunks row will reference (always `.webm`). Returns null when the
   * file is unusable or encoding failed — caller skips this file silently
   * (and a subsequent launch retries).
   */
  private async reconcileOrphan(
    sessionId: string,
    filePath: string,
    parsed: ParsedAudioName,
  ): Promise<OrphanResult | null> {
    if (parsed.ext === 'webm') {
      // Encoded but never persisted — probe duration, keep the file in place.
      const durationMs = await probeWebmDurationMs(filePath, this.logger);
      if (durationMs === null) return null;
      let bytes: number;
      try {
        bytes = fs.statSync(filePath).size;
      } catch {
        return null;
      }
      return { webmPath: filePath, durationMs, bytes, bucket: 'recoveredOrphanWebms' };
    }

    // .pcm or .wav both need an encode. Skip silently if no encoder wired
    // (tests can opt out by passing encoder=null).
    if (!this.encoder) {
      this.logger.debug('recovery: encoder not wired; leaving orphan in place', {
        sessionId,
        filePath,
        ext: parsed.ext,
      });
      return null;
    }

    if (parsed.ext === 'pcm') {
      let pcmBytes: number;
      try {
        pcmBytes = fs.statSync(filePath).size;
      } catch {
        return null;
      }
      if (pcmBytes <= 0) {
        tryUnlink(filePath);
        return null;
      }
      const durationMs = Math.round((pcmBytes / PCM_BYTES_PER_SECOND) * 1000);
      const webmPath = filePath.replace(/\.pcm$/, '.webm');
      let bytes: number;
      try {
        const r = await this.encoder.encode(filePath, webmPath);
        bytes = r.bytes;
      } catch (err) {
        this.logger.warn('recovery: orphan PCM encode failed; leaving for next launch', {
          sessionId,
          filePath,
          message: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
      tryUnlink(filePath);
      return { webmPath, durationMs, bytes, bucket: 'recoveredOrphanPcms' };
    }

    if (parsed.ext === 'wav') {
      // One-release legacy shim. Strip the 44-byte RIFF/WAVE header to get
      // the raw PCM body, write it to a temp `.pcm`, encode, unlink both.
      // We don't trust the WAV's internal size fields — we just read everything
      // after byte 44, matching what the pre-migration WAV writer produced.
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        return null;
      }
      if (stat.size <= LEGACY_WAV_HEADER_BYTES) {
        tryUnlink(filePath);
        return null;
      }
      const pcmBytes = stat.size - LEGACY_WAV_HEADER_BYTES;
      const durationMs = Math.round((pcmBytes / LEGACY_WAV_BYTES_PER_SECOND) * 1000);

      const tmpPcm = filePath.replace(/\.wav$/, '.legacy.pcm');
      try {
        const fd = fs.openSync(tmpPcm, 'w', 0o600);
        try {
          const src = fs.openSync(filePath, 'r');
          try {
            const buf = Buffer.alloc(64 * 1024);
            let offset = LEGACY_WAV_HEADER_BYTES;
            for (;;) {
              const n = fs.readSync(src, buf, 0, buf.length, offset);
              if (n <= 0) break;
              fs.writeSync(fd, buf, 0, n);
              offset += n;
            }
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(src);
          }
        } finally {
          fs.closeSync(fd);
        }
      } catch (err) {
        this.logger.warn('recovery: legacy WAV header strip failed', {
          sessionId,
          filePath,
          message: err instanceof Error ? err.message : String(err),
        });
        tryUnlink(tmpPcm);
        return null;
      }

      const webmPath = filePath.replace(/\.wav$/, '.webm');
      let bytes: number;
      try {
        const r = await this.encoder.encode(tmpPcm, webmPath);
        bytes = r.bytes;
      } catch (err) {
        this.logger.warn('recovery: legacy WAV encode failed; leaving for next launch', {
          sessionId,
          filePath,
          message: err instanceof Error ? err.message : String(err),
        });
        tryUnlink(tmpPcm);
        return null;
      }
      tryUnlink(tmpPcm);
      tryUnlink(filePath);
      return { webmPath, durationMs, bytes, bucket: 'recoveredLegacyWavs' };
    }

    return null;
  }
}

type ParsedAudioName = {
  chunkId: string;
  source: ChunkSource;
  ext: 'pcm' | 'webm' | 'wav';
};

type OrphanResult = {
  webmPath: string;
  durationMs: number;
  bytes: number;
  bucket: 'recoveredOrphanPcms' | 'recoveredOrphanWebms' | 'recoveredLegacyWavs';
};

/**
 * Parse a chunk filename of the form `<chunkId>.<source>.<ext>` where ext is
 * one of `pcm`, `webm`, `wav`. Returns null when the pattern doesn't match
 * or the source/ext aren't recognized.
 */
function parseChunkAudioName(name: string): ParsedAudioName | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot >= name.length - 1) return null;
  const extRaw = name.slice(dot + 1);
  if (extRaw !== 'pcm' && extRaw !== 'webm' && extRaw !== 'wav') return null;
  const withoutExt = name.slice(0, dot);
  const dot2 = withoutExt.lastIndexOf('.');
  if (dot2 <= 0 || dot2 >= withoutExt.length - 1) return null;
  const chunkId = withoutExt.slice(0, dot2);
  const sourceStr = withoutExt.slice(dot2 + 1);
  if (!(VALID_CHUNK_SOURCES as readonly string[]).includes(sourceStr)) return null;
  return { chunkId, source: sourceStr as ChunkSource, ext: extRaw };
}

/**
 * Probe duration of a WebM/Opus file by invoking the bundled ffmpeg with
 * `-i` (no -o), parsing the `Duration: HH:MM:SS.ms` line from stderr.
 *
 * We use ffmpeg rather than ffprobe because ffmpeg-static doesn't ship the
 * ffprobe binary, and shelling out to a system ffprobe isn't reliable
 * (Electron apps don't get $PATH from the user shell on macOS).
 *
 * Returns null when probing fails — caller skips this file for now.
 */
async function probeWebmDurationMs(filePath: string, logger: Logger): Promise<number | null> {
  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) {
    logger.warn('recovery: cannot probe webm, ffmpeg-static unavailable');
    return null;
  }
  return await new Promise<number | null>((resolve) => {
    let child;
    try {
      child = spawn(ffmpegPath, ['-hide_banner', '-i', filePath], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch {
      resolve(null);
      return;
    }
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
    });
    child.on('error', () => resolve(null));
    // ffmpeg with no output spec exits non-zero ("at least one output file
    // required") but still prints Duration before bailing.
    child.on('close', () => {
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!m) {
        resolve(null);
        return;
      }
      const h = Number(m[1]);
      const min = Number(m[2]);
      const s = Number(m[3]);
      if (!Number.isFinite(h) || !Number.isFinite(min) || !Number.isFinite(s)) {
        resolve(null);
        return;
      }
      resolve(Math.round((h * 3600 + min * 60 + s) * 1000));
    });
    // Bounded timeout — ffmpeg should print Duration within a few hundred ms.
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* best-effort */
      }
      resolve(null);
    }, 5_000);
  });
}

/** `true` iff `p` exists (any kind of file). Errors swallowed → `false`. */
function fileExists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort unlink; swallows errors because callers don't have a remediation. */
function tryUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    /* best-effort */
  }
}
