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
 * Deferred (no evidence yet that these cases occur in practice — add when seen):
 *   - transcribed but no transcripts row (impossible if the success txn worked)
 *   - file exists, no row → reconstruct row from filename
 *   - WAV header truncated → rewrite RIFF length
 *   - same chunk twice in DB and on disk
 *
 * Pure in spirit: takes the dependencies it needs and emits a report; no
 * background timers, no listeners. The composition root calls `recover()` once
 * at startup and schedules a daily retention sweep on top.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ChunkSource, JobStore } from '@core/storage/JobStore';
import type { Clock } from '@core/util/Clock';
import { type Logger, noopLogger } from '@core/observability/Logger';

// WAV format constants — must match WavFileWriter (16 kHz mono int16). Kept
// duplicated here rather than imported so RecoveryService doesn't drag in
// the writer module just for two numbers.
const WAV_HEADER_BYTES = 44;
const WAV_BYTES_PER_SECOND = 16_000 * 1 * 2; // sample_rate * channels * bytes/sample
const VALID_CHUNK_SOURCES: readonly ChunkSource[] = ['mic', 'mixed'];

export interface RecoveryOptions {
  /** §11.5: 'uploading' rows untouched longer than this → reset. Default 10 min. */
  readonly staleUploadingMs: number;
  /** §7.10: paused_by_sleep sessions older than this → auto-end. Default 30 min. */
  readonly sleepTimeoutMs: number;
  /** §11.7: failed_permanent audio files older than this → delete. Default 30 days. */
  readonly retentionMs: number;
}

export const DEFAULT_RECOVERY_OPTIONS: RecoveryOptions = {
  staleUploadingMs: 10 * 60 * 1000,
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
   * "Generate summary" (manual retry). The backend dedupes by meeting_id,
   * so a re-fire is harmless even if it had already completed server-side.
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
   * WAV files in `recordings/<sessionId>/` with no matching `chunks` row.
   * Happens when the app is force-quit mid-record before the in-flight
   * chunk's `chunk_closed` reply arrives from the audio-process. The sweep
   * fixes up the RIFF header (placeholder size fields → real sizes),
   * inserts a `chunks` row as `captured`, and lets the UploadQueue
   * transcribe it on next launch.
   */
  recoveredOrphanWavs: number;
}

export class RecoveryService {
  /**
   * Configure with the store, clock, and recovery thresholds.
   * `recordingsDir` is required for the orphan-WAV sweep; pass `null` in
   * unit tests that don't touch the filesystem to skip that step.
   */
  constructor(
    private readonly store: JobStore,
    private readonly clock: Clock,
    private readonly recordingsDir: string | null,
    private readonly options: RecoveryOptions = DEFAULT_RECOVERY_OPTIONS,
    private readonly logger: Logger = noopLogger,
  ) {}

  /**
   * Run all enabled recovery passes in order; returns the count summary the
   * UI uses to show the "Recovered an interrupted recording" banner.
   */
  recover(): RecoveryReport {
    const report: RecoveryReport = {
      staleSleepSessions: 0,
      resetUploading: 0,
      orphanCompletedFilesDeleted: 0,
      rowsMarkedFileLost: 0,
      retentionFilesDeleted: 0,
      staleSummaryPending: 0,
      crashRecoveredActive: 0,
      unresumedDeviceLoss: 0,
      recoveredOrphanWavs: 0,
    };

    // 0. Crash recovery — runs FIRST so subsequent sweeps see consistent
    //    session state. Sessions stuck in 'active' or 'paused_by_device_loss'
    //    at startup are orphans from a prior process that crashed / was
    //    force-quit. Both are force-ended with a distinct end_reason so they
    //    stop showing the "live" / "paused (mic disconnected)" badge.
    report.crashRecoveredActive = this.store.autoEndCrashRecoveredActive();
    report.unresumedDeviceLoss = this.store.autoEndUnresumedDeviceLoss();

    // 1. Sleep timeout — sessions that were paused by sleep too long ago auto-end.
    report.staleSleepSessions = this.store.autoEndStaleSleepPaused(
      this.clock.now(),
      this.options.sleepTimeoutMs,
    );

    // 2. Stuck uploading → captured so the queue picks them up again.
    report.resetUploading = this.store.resetStuckUploading(this.options.staleUploadingMs);

    // 3. completed + file still present → delete file (the queue's post-commit
    //    delete may have failed or never ran due to crash).
    for (const c of this.store.findCompletedRows()) {
      if (fileExists(c.file_path)) {
        tryUnlink(c.file_path);
        report.orphanCompletedFilesDeleted++;
      }
    }

    // 4. Row points at a missing file and we haven't deleted it on purpose →
    //    mark failed_permanent with reason='file_lost'. Note: 'completed' rows
    //    that pass through case 3 above are already handled; we filter them out
    //    via the JobStore.findChunksForFileCheck query.
    for (const c of this.store.findChunksForFileCheck()) {
      if (!fileExists(c.file_path)) {
        this.store.markChunkFileLost(c.id);
        report.rowsMarkedFileLost++;
      }
    }

    // 5. Stale summary 'pending' → 'failed' so the UI shows "Generate summary".
    //    Backend dedupes by meeting_id, so re-firing on user click is safe.
    report.staleSummaryPending = this.store.recoverStaleSummaryPending();

    // 6. Retention sweep: failed_permanent files aged past the horizon.
    const due = this.store.findFailedPermanentDueForRetention(this.options.retentionMs);
    const now = this.clock.now();
    for (const c of due) {
      tryUnlink(c.file_path);
      this.store.markChunkFileDeleted(c.id, now);
      report.retentionFilesDeleted++;
    }

    // 7. Orphan-WAV sweep: WAV files in recordings/<sessionId>/ that have no
    //    matching chunks row. Caused by force-quit (or kernel panic) before
    //    the in-flight chunk's chunk_closed reply arrived — see
    //    ChunkWriter.finalizeAllOnShutdown for the graceful path. Recovery
    //    fixes the RIFF header, inserts a captured chunks row, and lets the
    //    upload queue transcribe it. Skipped if no recordings dir was wired
    //    (unit tests).
    if (this.recordingsDir !== null) {
      report.recoveredOrphanWavs = this.recoverOrphanWavFiles(this.recordingsDir);
    }

    this.logger.info('recovery completed', { ...report });
    return report;
  }

  /**
   * Scan `recordings/<sessionId>/*.wav`; for any file without a chunks row,
   * fix up the RIFF header and insert a captured chunks row. Idempotent:
   * a second pass finds no orphans because the first inserted the rows.
   *
   * Files in directories whose session_id doesn't exist in the DB are left
   * alone — they belong to a deleted session and should be cleaned by a
   * separate cascade-delete path (not this sweep's job).
   */
  private recoverOrphanWavFiles(recordingsDir: string): number {
    let recovered = 0;
    let sessionDirs: string[];
    try {
      sessionDirs = fs.readdirSync(recordingsDir);
    } catch {
      // recordings/ doesn't exist yet (fresh install, never recorded). Fine.
      return 0;
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

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.wav')) continue;
        const parsed = parseChunkWavName(entry.name);
        if (!parsed) continue;
        if (this.store.getChunk(parsed.chunkId)) continue; // not orphan

        const filePath = path.join(sessionDir, entry.name);
        const measured = fixupAndMeasureWav(filePath);
        if (!measured) {
          // Empty or unreadable file — best effort cleanup.
          tryUnlink(filePath);
          continue;
        }

        maxIdx += 1;
        const startMs = lastEndMs;
        const endMs = startMs + measured.durationMs;

        try {
          this.store.insertChunk({
            id: parsed.chunkId,
            session_id: sessionId,
            idx: maxIdx,
            source: parsed.source,
            file_path: filePath,
            start_ms: startMs,
            end_ms: endMs,
            overlap_prefix_ms: 0,
            duration_ms: measured.durationMs,
            bytes: measured.bytes,
            sha256: null,
            device_boundary: false,
            sleep_boundary: false,
          });
          lastEndMs = endMs;
          recovered++;
          this.logger.info('recovery: orphan WAV reconstructed', {
            sessionId,
            chunkId: parsed.chunkId,
            source: parsed.source,
            durationMs: measured.durationMs,
            bytes: measured.bytes,
          });
        } catch (err) {
          this.logger.warn('recovery: orphan WAV insertChunk failed', {
            sessionId,
            chunkId: parsed.chunkId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    return recovered;
  }
}

/**
 * Parse a chunk WAV filename of the form `<chunkId>.<source>.wav`. Returns
 * null when the pattern doesn't match or the source isn't a known
 * ChunkSource — we don't want to invent rows for files we can't identify.
 */
function parseChunkWavName(name: string): { chunkId: string; source: ChunkSource } | null {
  const withoutExt = name.slice(0, -'.wav'.length);
  const dot = withoutExt.lastIndexOf('.');
  if (dot <= 0 || dot >= withoutExt.length - 1) return null;
  const chunkId = withoutExt.slice(0, dot);
  const sourceStr = withoutExt.slice(dot + 1);
  if (!(VALID_CHUNK_SOURCES as readonly string[]).includes(sourceStr)) return null;
  return { chunkId, source: sourceStr as ChunkSource };
}

/**
 * Patch the RIFF chunk-size + data-subchunk-size fields in an orphan WAV
 * so the file is a valid 16 kHz mono int16 WAV (matching WavFileWriter).
 * Returns { bytes, durationMs } on success; null if the file is too short
 * to contain any audio or can't be opened.
 *
 * Idempotent — re-running on an already-patched file produces the same
 * size fields.
 */
function fixupAndMeasureWav(filePath: string): { bytes: number; durationMs: number } | null {
  let fd: number | null = null;
  try {
    const stat = fs.statSync(filePath);
    const totalBytes = stat.size;
    if (totalBytes <= WAV_HEADER_BYTES) return null;
    const dataBytes = totalBytes - WAV_HEADER_BYTES;

    fd = fs.openSync(filePath, 'r+');
    const sizes = Buffer.alloc(4);

    // RIFF chunk size at offset 4 = file size - 8.
    sizes.writeUInt32LE(totalBytes - 8, 0);
    fs.writeSync(fd, sizes, 0, 4, 4);
    // data subchunk size at offset 40 = PCM byte count.
    sizes.writeUInt32LE(dataBytes, 0);
    fs.writeSync(fd, sizes, 0, 4, 40);
    fs.fsyncSync(fd);

    const durationMs = Math.round((dataBytes / WAV_BYTES_PER_SECOND) * 1000);
    return { bytes: totalBytes, durationMs };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }
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
