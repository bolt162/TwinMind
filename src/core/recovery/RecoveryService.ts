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
import type { JobStore } from '@core/storage/JobStore';
import type { Clock } from '@core/util/Clock';
import { type Logger, noopLogger } from '@core/observability/Logger';

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
}

export class RecoveryService {
  /** Configure with the store, clock, and recovery thresholds. */
  constructor(
    private readonly store: JobStore,
    private readonly clock: Clock,
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
    };

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

    // 5. Retention sweep: failed_permanent files aged past the horizon.
    const due = this.store.findFailedPermanentDueForRetention(this.options.retentionMs);
    const now = this.clock.now();
    for (const c of due) {
      tryUnlink(c.file_path);
      this.store.markChunkFileDeleted(c.id, now);
      report.retentionFilesDeleted++;
    }

    this.logger.info('recovery completed', { ...report });
    return report;
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
