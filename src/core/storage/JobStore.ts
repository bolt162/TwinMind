/**
 * JobStore — the single point of access to SQLite.
 *
 * Architecture: §5 (Repository pattern), §10 (schema), §10.3 (chunk FSM),
 * §11.1 (outbox), §11.5 (recovery), §11.7 (retention), §7.10 (sleep), §7.11 (VAD).
 *
 * Design rules:
 *  - All writes that touch more than one row, or more than one table, go through
 *    `db.transaction(...).immediate()` so a crash mid-operation rolls back fully.
 *  - State-machine transitions use CAS-style UPDATEs (filter by allowed `from`
 *    states); if rowsAffected != 1 we throw, so no silent FSM violations.
 *  - Return types use the schema's snake_case column names. Domain mapping
 *    happens in callers, not here.
 *  - No file I/O. Callers pass in `deleteFileFn` callbacks for the post-commit
 *    file unlink; if they throw, the next launch's RecoveryService cleans up.
 */

import type { Database, Statement } from 'better-sqlite3';
import type { ChunkState } from '@core/state/ChunkState';
import type { Clock } from '@core/util/Clock';

// ─── Row types (mirrors schema) ─────────────────────────────────────────────

export type SessionMode = 'dictation' | 'meeting';
export type SessionStatus =
  | 'active'
  | 'ended'
  | 'paused_by_sleep'
  | 'paused_by_device_loss';
export type ChunkSource = 'mic' | 'mixed';

export interface SessionRow {
  id: string;
  mode: SessionMode;
  status: SessionStatus;
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
  title: string | null;
  device_label: string | null;
  created_at: number;
  synced_at: number | null;
  remote_id: string | null;
}

export interface ChunkRow {
  id: string;
  session_id: string;
  idx: number;
  source: ChunkSource;
  file_path: string;
  start_ms: number;
  end_ms: number;
  overlap_prefix_ms: number;
  duration_ms: number;
  bytes: number;
  sha256: string | null;
  state: ChunkState;
  attempts: number;
  next_attempt_at: number | null;
  last_error_class: string | null;
  last_error_msg: string | null;
  device_boundary: number;
  sleep_boundary: number;
  file_deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface TranscriptRow {
  chunk_id: string;
  text: string;
  words_json: string | null;
  provider: string;
  model: string | null;
  language: string | null;
  confidence: number | null;
  created_at: number;
  synced_at: number | null;
}

export type MicActivityState =
  | 'started'
  | 'stopped'
  | 'notified'
  | 'dismissed'
  | 'accepted'
  | 'suppressed';

export interface MicActivityRow {
  id: number;
  occurred_at: number;
  state: MicActivityState;
  source_pid: number | null;
  source_bundle: string | null;
  meta: string | null;
}

// ─── Input shapes ────────────────────────────────────────────────────────────

export interface NewSessionInput {
  id: string;
  mode: SessionMode;
  started_at: number;
  title?: string | null;
  device_label?: string | null;
}

export interface NewChunkInput {
  id: string;
  session_id: string;
  idx: number;
  source: ChunkSource;
  file_path: string;
  start_ms: number;
  end_ms: number;
  overlap_prefix_ms: number;
  duration_ms: number;
  bytes: number;
  sha256: string | null;
  device_boundary: boolean;
  sleep_boundary: boolean;
}

export interface TranscriptInput {
  chunk_id: string;
  text: string;
  words_json: string | null;
  provider: string;
  model: string | null;
  language: string | null;
  confidence: number | null;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Thrown when a CAS-style UPDATE for a state transition matches zero rows.
 * Either the chunk doesn't exist, or its current state isn't in the allowed
 * `from` set for the operation. Either way: caller bug or stale read.
 */
export class ChunkTransitionConflict extends Error {
  constructor(public readonly chunkId: string, public readonly intent: string) {
    super(`Chunk ${chunkId} not in expected state for ${intent}`);
    this.name = 'ChunkTransitionConflict';
  }
}

// ─── JobStore ────────────────────────────────────────────────────────────────

export class JobStore {
  // Prepared statements are cached on first use; better-sqlite3 keeps them
  // compiled and reusable. Don't recompute them per call.
  private readonly stmts: Record<string, Statement>;

  /** Construct over an opened `Database` and a `Clock` (for `updated_at` stamps). */
  constructor(private readonly db: Database, private readonly clock: Clock) {
    this.stmts = this.prepareStatements();
  }

  // ─── Sessions ──────────────────────────────────────────────────────────────

  /** Insert a new active session and return the persisted row. */
  createSession(input: NewSessionInput): SessionRow {
    const now = this.clock.now();
    this.stmts.insertSession.run({
      id: input.id,
      mode: input.mode,
      started_at: input.started_at,
      title: input.title ?? null,
      device_label: input.device_label ?? null,
      created_at: now,
    });
    return this.getSessionOrThrow(input.id);
  }

  /** Mark a session ended with the given `end_reason` (see §7.6 reasons). */
  endSession(id: string, endedAt: number, endReason: string): void {
    const r = this.stmts.endSession.run({ id, ended_at: endedAt, end_reason: endReason });
    if (r.changes !== 1) throw new Error(`endSession: session ${id} not found`);
  }

  /** Mark a session as paused_by_sleep (§7.10); ended_at stays null. */
  markSessionPausedBySleep(id: string): void {
    const r = this.stmts.pauseSessionForSleep.run({ id });
    if (r.changes !== 1) throw new Error(`markSessionPausedBySleep: session ${id} not active`);
  }

  /** Mark a session as paused_by_device_loss; ended_at stays null. Same
   *  shape as sleep-pause; resumable via `markSessionActive`. */
  markSessionPausedByDeviceLoss(id: string): void {
    const r = this.stmts.pauseSessionForDeviceLoss.run({ id });
    if (r.changes !== 1) {
      throw new Error(`markSessionPausedByDeviceLoss: session ${id} not active`);
    }
  }

  /** Resume a paused session — flips status back to 'active'. Accepts either
   *  paused_by_sleep or paused_by_device_loss as the starting state. */
  markSessionActive(id: string): void {
    const r = this.stmts.resumeSession.run({ id });
    if (r.changes !== 1) {
      throw new Error(`markSessionActive: session ${id} not in a paused state`);
    }
  }

  /** Rename a session. Passing null clears the title (UI then falls back to
   *  "Untitled <mode>"). Silently no-ops on unknown id — the renderer treats
   *  this as fire-and-forget; an in-flight session that was just deleted
   *  shouldn't crash the IPC. */
  updateSessionTitle(id: string, title: string | null): void {
    this.stmts.updateSessionTitle.run({ id, title });
  }

  /** Most recently-ended (or active) session's mode. Used by main to route the
   *  HUD's History button to the matching tab (Dictations vs Meetings) after
   *  we split the single Sessions tab into two. Returns null if there are no
   *  sessions on disk yet. */
  latestSessionMode(): 'dictation' | 'meeting' | null {
    const row = this.stmts.latestSessionMode.get() as { mode: 'dictation' | 'meeting' } | undefined;
    return row?.mode ?? null;
  }

  /**
   * Bulk fetch of dictation sessions + their inline transcripts, for the
   * Dictations tile view (no drill-in step — everything shown at once).
   *
   * Implementation note: filters the existing failure-count query in JS
   * rather than adding a parameterized mode SQL. The list is capped at
   * `limit` (default 50 at the IPC layer) and N+1 transcript fetches via
   * the prepared `listTranscriptsForSession` statement run in <5 ms total
   * for that scale — adding a JOIN-and-json_group_array variant would be
   * faster theoretically but harder to maintain and not measurable here.
   */
  listDictationsWithTranscripts(limit: number): Array<{
    readonly id: string;
    readonly status: SessionRow['status'];
    readonly startedAt: number;
    readonly endedAt: number | null;
    readonly failedCount: number;
    readonly transcripts: ReadonlyArray<{
      readonly chunkId: string;
      readonly startMs: number;
      readonly endMs: number;
      readonly overlapPrefixMs: number;
      readonly text: string;
    }>;
  }> {
    const sessions = this.listSessionsWithFailureCounts(limit).filter(
      (s) => s.mode === 'dictation',
    );
    return sessions.map((s) => {
      const rows = this.stmts.listTranscriptsForSession.all({ session_id: s.id }) as Array<{
        chunk_id: string;
        start_ms: number;
        end_ms: number;
        overlap_prefix_ms: number;
        text: string;
      }>;
      return {
        id: s.id,
        status: s.status,
        startedAt: s.started_at,
        endedAt: s.ended_at,
        failedCount: s.failed_count,
        transcripts: rows.map((r) => ({
          chunkId: r.chunk_id,
          startMs: r.start_ms,
          endMs: r.end_ms,
          overlapPrefixMs: r.overlap_prefix_ms,
          text: r.text,
        })),
      };
    });
  }

  /** Look up a session by id. */
  getSession(id: string): SessionRow | undefined {
    return this.stmts.getSession.get({ id }) as SessionRow | undefined;
  }

  /** List the N most recent sessions, newest first. */
  listSessions(limit: number): SessionRow[] {
    return this.stmts.listSessions.all({ limit }) as SessionRow[];
  }

  /**
   * Same as `listSessions` but each row carries a `failed_count`: the number
   * of `failed_permanent` chunks that are transient (network/timeout/5xx/etc.
   * — i.e. retryable in principle). Auth/bad-audio/4xx failures don't show up
   * because re-uploading would just fail again.
   */
  listSessionsWithFailureCounts(
    limit: number,
  ): Array<SessionRow & { failed_count: number }> {
    return this.stmts.listSessionsWithFailureCounts.all({ limit }) as Array<
      SessionRow & { failed_count: number }
    >;
  }

  /** Delete a session and (via FK CASCADE) all its chunks + transcripts. */
  deleteSession(id: string): void {
    this.stmts.deleteSession.run({ id });
  }

  /**
   * Fetch a session + its transcripts joined to chunks (ordered by chunk idx).
   * Used by the renderer's SessionDetail view.
   *
   * Returns `null` if the session doesn't exist. Chunks without a transcript
   * row yet (still uploading or VAD-skipped) are simply absent from the list;
   * we don't synthesize empty entries here.
   */
  getSessionWithTranscripts(id: string): {
    readonly session: SessionRow;
    readonly transcripts: ReadonlyArray<{
      readonly chunkId: string;
      readonly startMs: number;
      readonly endMs: number;
      readonly overlapPrefixMs: number;
      readonly text: string;
    }>;
  } | null {
    const session = this.getSession(id);
    if (!session) return null;
    const rows = this.stmts.listTranscriptsForSession.all({ session_id: id }) as Array<{
      chunk_id: string;
      start_ms: number;
      end_ms: number;
      overlap_prefix_ms: number;
      text: string;
    }>;
    return {
      session,
      transcripts: rows.map((r) => ({
        chunkId: r.chunk_id,
        startMs: r.start_ms,
        endMs: r.end_ms,
        overlapPrefixMs: r.overlap_prefix_ms,
        text: r.text,
      })),
    };
  }

  /**
   * Highest `end_ms` across all chunks of a session. Used by
   * `resumeFromDeviceLoss` to anchor the next chunk to where audio actually
   * stopped (the last chunk's stored end_ms = the audio-clock at pause),
   * not to wall-clock-since-session-start. Without this, the resumed chunk
   * would surface as a visible gap on the transcript list.
   *
   * Returns 0 if the session has no chunks yet (shouldn't happen on resume,
   * but defensive).
   */
  getMaxChunkEndMsForSession(sessionId: string): number {
    const row = this.stmts.getMaxChunkEndMs.get({ session_id: sessionId }) as
      | { max_end_ms: number | null }
      | undefined;
    return row?.max_end_ms ?? 0;
  }

  /**
   * Reset transient `failed_permanent` chunks back to `captured` so the
   * UploadQueue picks them up again. Only retryable error classes are reset
   * — permanently dead audio (auth, bad_audio, client_4xx) stays failed so
   * we don't loop on it. Pass `sessionId` to scope to one session; omit to
   * reset everywhere. Returns the ids of the chunks actually reset; callers
   * use this list to track the retry batch's completion in the UI.
   */
  resetFailedToCaptured(sessionId?: string): string[] {
    const now = this.clock.now();
    const rows = sessionId
      ? (this.stmts.resetFailedToCapturedForSession.all({
          now,
          session_id: sessionId,
        }) as Array<{ id: string }>)
      : (this.stmts.resetFailedToCapturedAll.all({ now }) as Array<{ id: string }>);
    return rows.map((r) => r.id);
  }

  /**
   * Count `failed_permanent` chunks in retryable error classes. Used by the
   * retry-UX layer to decide whether to surface a failure state. Pass a
   * `sessionId` to scope; omit for global.
   */
  countFailedChunks(sessionId?: string): number {
    const row = sessionId
      ? (this.stmts.countFailedChunksForSession.get({ session_id: sessionId }) as {
          c: number;
        })
      : (this.stmts.countFailedChunksAll.get() as { c: number });
    return row.c;
  }

  /**
   * Return the most recent session that still has retryable failed chunks,
   * or `null` if none. "Most recent" = session with the greatest started_at.
   * Used to pick which session the HUD's failed-state Retry button targets.
   */
  findMostRecentSessionWithFailures(): string | null {
    const row = this.stmts.findMostRecentSessionWithFailures.get() as
      | { session_id: string }
      | undefined;
    return row?.session_id ?? null;
  }

  /**
   * Delete every row in sessions / chunks / transcripts / mic_activity / kv.
   * The kv `groq_api_key_enc` row would also be deleted; callers that want to
   * preserve secrets should snapshot and restore around this call.
   *
   * Wrapped in an immediate transaction so a crash mid-nuke either leaves the
   * DB untouched or wholly empty. FK CASCADE handles chunks/transcripts as a
   * side-effect of dropping the sessions, but we delete explicitly to be
   * defensive against future schema changes that loosen cascade.
   */
  wipeAll(): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM transcripts`).run();
      this.db.prepare(`DELETE FROM chunks`).run();
      this.db.prepare(`DELETE FROM sessions`).run();
      this.db.prepare(`DELETE FROM mic_activity_events`).run();
      this.db.prepare(`DELETE FROM kv`).run();
    }).immediate();
  }

  /**
   * Recovery helper for §11.5: auto-end sessions that were paused by sleep more
   * than `ageMs` ago. Returns the number of sessions ended.
   */
  autoEndStaleSleepPaused(now: number, ageMs: number): number {
    const r = this.stmts.autoEndStaleSleepPaused.run({
      now,
      threshold: now - ageMs,
    });
    return r.changes;
  }

  /**
   * Same as `autoEndStaleSleepPaused` but for `paused_by_device_loss` —
   * sessions sitting paused because the pinned mic disappeared and the
   * user never picked a replacement. Bounded by the same retention window.
   */
  autoEndStaleDeviceLossPaused(now: number, ageMs: number): number {
    const r = this.stmts.autoEndStaleDeviceLossPaused.run({
      now,
      threshold: now - ageMs,
    });
    return r.changes;
  }

  // ─── Chunks: inserts and reads ─────────────────────────────────────────────

  /** Insert a new captured chunk; returns the persisted row. */
  insertChunk(input: NewChunkInput): ChunkRow {
    const now = this.clock.now();
    this.stmts.insertChunk.run({
      id: input.id,
      session_id: input.session_id,
      idx: input.idx,
      source: input.source,
      file_path: input.file_path,
      start_ms: input.start_ms,
      end_ms: input.end_ms,
      overlap_prefix_ms: input.overlap_prefix_ms,
      duration_ms: input.duration_ms,
      bytes: input.bytes,
      sha256: input.sha256,
      state: 'captured',
      device_boundary: input.device_boundary ? 1 : 0,
      sleep_boundary: input.sleep_boundary ? 1 : 0,
      created_at: now,
      updated_at: now,
    });
    return this.getChunkOrThrow(input.id);
  }

  /** Look up a chunk by id. */
  getChunk(id: string): ChunkRow | undefined {
    return this.stmts.getChunk.get({ id }) as ChunkRow | undefined;
  }

  /** List all chunks of a session, ordered by (idx, source). */
  listChunksForSession(sessionId: string): ChunkRow[] {
    return this.stmts.listChunksForSession.all({ session_id: sessionId }) as ChunkRow[];
  }

  /**
   * UploadQueue tick query (§11.1): the next `limit` chunks eligible for upload.
   * Matches ELIGIBLE_FOR_UPLOAD in ChunkState.ts; if you change one, change the
   * other and the unit test will catch drift.
   */
  pickEligibleChunks(now: number, limit: number): ChunkRow[] {
    return this.stmts.pickEligibleChunks.all({ now, limit }) as ChunkRow[];
  }

  // ─── Chunks: state-machine transitions (CAS) ───────────────────────────────

  /**
   * captured | failed_retry → uploading.
   * Throws `ChunkTransitionConflict` if the chunk isn't in an eligible state.
   */
  recordChunkUploadStart(chunkId: string): void {
    const now = this.clock.now();
    const r = this.stmts.markUploading.run({ id: chunkId, now });
    if (r.changes !== 1) throw new ChunkTransitionConflict(chunkId, 'upload-start');
  }

  /**
   * Atomic success path: uploading → transcribed → completed in one transaction,
   * with the `transcripts` row inserted in the same txn. The audio file delete
   * runs AFTER commit; if it throws, the next launch's RecoveryService (§11.5
   * "completed and file still exists → Delete file") cleans up.
   *
   * Why two state changes in one txn instead of just → completed: the FSM is
   * documented as captured → uploading → transcribed → completed. Keeping the
   * intermediate state explicit makes recovery enumerable.
   */
  recordChunkSuccessAndComplete(
    transcript: TranscriptInput,
    deleteFileFn: () => void,
  ): void {
    const chunkId = transcript.chunk_id;
    const now = this.clock.now();
    const apply = this.db.transaction(() => {
      this.stmts.insertTranscript.run({
        chunk_id: transcript.chunk_id,
        text: transcript.text,
        words_json: transcript.words_json,
        provider: transcript.provider,
        model: transcript.model,
        language: transcript.language,
        confidence: transcript.confidence,
        created_at: now,
      });
      const t = this.stmts.markTranscribed.run({ id: chunkId, now });
      if (t.changes !== 1) throw new ChunkTransitionConflict(chunkId, 'success-transcribed');
      const c = this.stmts.markCompleted.run({ id: chunkId, now });
      if (c.changes !== 1) throw new ChunkTransitionConflict(chunkId, 'success-completed');
    });
    apply.immediate();

    // Post-commit. Failure here is recoverable on next launch.
    try {
      deleteFileFn();
    } catch {
      // Intentionally swallowed: RecoveryService handles orphaned completed files.
    }
  }

  /** uploading → failed_retry with backoff target and last error metadata. */
  recordChunkRetryableFailure(
    chunkId: string,
    nextAttemptAt: number,
    errorClass: string,
    errorMsg: string,
  ): void {
    const now = this.clock.now();
    const r = this.stmts.markFailedRetry.run({
      id: chunkId,
      now,
      next_attempt_at: nextAttemptAt,
      err_class: errorClass,
      err_msg: errorMsg,
    });
    if (r.changes !== 1) throw new ChunkTransitionConflict(chunkId, 'retryable-failure');
  }

  /** uploading | failed_retry → failed_permanent. Terminal; no further upload attempts. */
  recordChunkPermanentFailure(chunkId: string, errorClass: string, errorMsg: string): void {
    const now = this.clock.now();
    const r = this.stmts.markFailedPermanent.run({
      id: chunkId,
      now,
      err_class: errorClass,
      err_msg: errorMsg,
    });
    if (r.changes !== 1) throw new ChunkTransitionConflict(chunkId, 'permanent-failure');
  }

  // ─── Recovery helpers (§11.5) ──────────────────────────────────────────────

  /**
   * Reset 'uploading' rows that haven't been touched in `staleAfterMs` back to
   * 'captured' so the queue picks them up again. Attempts count is preserved.
   * Returns the number of rows reset.
   */
  resetStuckUploading(staleAfterMs: number): number {
    const now = this.clock.now();
    const r = this.stmts.resetStuckUploading.run({
      now,
      threshold: now - staleAfterMs,
    });
    return r.changes;
  }

  /** §11.5: rows where state='completed' but the file is still present on disk. */
  findCompletedRows(): ChunkRow[] {
    return this.stmts.findCompleted.all() as ChunkRow[];
  }

  /** §11.5: rows pointing at a file that no longer exists (and not retention-deleted). */
  findChunksForFileCheck(): ChunkRow[] {
    return this.stmts.findChunksForFileCheck.all() as ChunkRow[];
  }

  /** Mark a chunk's file as lost (recovery couldn't find it; not retention). */
  markChunkFileLost(chunkId: string): void {
    const now = this.clock.now();
    this.stmts.markFailedPermanentFromAny.run({
      id: chunkId,
      now,
      err_class: 'file_lost',
      err_msg: 'audio file missing on disk',
    });
  }

  // ─── Retention sweep (§11.7) ───────────────────────────────────────────────

  /**
   * Identify failed_permanent chunks whose audio file should be removed:
   * rows older than `retentionMs` whose `file_deleted_at` is still NULL.
   * Caller does the unlink, then invokes `markChunkFileDeleted(id, now)`.
   */
  findFailedPermanentDueForRetention(retentionMs: number): ChunkRow[] {
    const now = this.clock.now();
    return this.stmts.findRetentionDue.all({
      threshold: now - retentionMs,
    }) as ChunkRow[];
  }

  /** Stamp `file_deleted_at` after the retention sweep removed the audio file. */
  markChunkFileDeleted(chunkId: string, now: number): void {
    this.stmts.markFileDeleted.run({ id: chunkId, deleted_at: now });
  }

  // ─── Transcripts ──────────────────────────────────────────────────────────

  /** Fetch the transcript for a chunk if it exists (for renderer display). */
  getTranscript(chunkId: string): TranscriptRow | undefined {
    return this.stmts.getTranscript.get({ chunk_id: chunkId }) as TranscriptRow | undefined;
  }

  // ─── Mic-activity log (§8 transparency view) ──────────────────────────────

  /** Append a mic-activity event row. */
  recordMicActivityEvent(input: {
    occurred_at: number;
    state: MicActivityState;
    source_pid?: number | null;
    source_bundle?: string | null;
    meta?: string | null;
  }): void {
    this.stmts.insertMicActivity.run({
      occurred_at: input.occurred_at,
      state: input.state,
      source_pid: input.source_pid ?? null,
      source_bundle: input.source_bundle ?? null,
      meta: input.meta ?? null,
    });
  }

  /** Latest `limit` mic-activity events, newest first. */
  listMicActivityEvents(limit: number): MicActivityRow[] {
    return this.stmts.listMicActivity.all({ limit }) as MicActivityRow[];
  }

  // ─── KV store ─────────────────────────────────────────────────────────────

  /** Read a value by key; returns undefined if absent. */
  getKv(k: string): string | undefined {
    const row = this.stmts.getKv.get({ k }) as { v: string } | undefined;
    return row?.v;
  }

  /** Upsert a key→value pair with `updated_at` set to the current clock. */
  setKv(k: string, v: string): void {
    this.stmts.setKv.run({ k, v, updated_at: this.clock.now() });
  }

  /** Delete a key if present; no-op otherwise. */
  deleteKv(k: string): void {
    this.stmts.deleteKv.run({ k });
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private getSessionOrThrow(id: string): SessionRow {
    const r = this.getSession(id);
    if (!r) throw new Error(`session ${id} not found just after insert`);
    return r;
  }

  private getChunkOrThrow(id: string): ChunkRow {
    const r = this.getChunk(id);
    if (!r) throw new Error(`chunk ${id} not found just after insert`);
    return r;
  }

  /**
   * Compile every prepared statement once at construction. Centralized so the
   * SQL strings are easy to audit in one place; keep the same column order as
   * the schema where reasonable.
   */
  private prepareStatements(): Record<string, Statement> {
    return {
      // ── sessions ──
      insertSession: this.db.prepare(`
        INSERT INTO sessions (id, mode, status, started_at, title, device_label, created_at)
        VALUES (@id, @mode, 'active', @started_at, @title, @device_label, @created_at)
      `),
      endSession: this.db.prepare(`
        UPDATE sessions SET status='ended', ended_at=@ended_at, end_reason=@end_reason
        WHERE id=@id AND status='active'
      `),
      pauseSessionForSleep: this.db.prepare(`
        UPDATE sessions SET status='paused_by_sleep' WHERE id=@id AND status='active'
      `),
      pauseSessionForDeviceLoss: this.db.prepare(`
        UPDATE sessions SET status='paused_by_device_loss' WHERE id=@id AND status='active'
      `),
      resumeSession: this.db.prepare(`
        UPDATE sessions SET status='active'
        WHERE id=@id AND status IN ('paused_by_sleep','paused_by_device_loss')
      `),
      updateSessionTitle: this.db.prepare(`
        UPDATE sessions SET title=@title WHERE id=@id
      `),
      latestSessionMode: this.db.prepare(`
        SELECT mode FROM sessions
        ORDER BY COALESCE(ended_at, started_at) DESC
        LIMIT 1
      `),
      getSession: this.db.prepare(`SELECT * FROM sessions WHERE id=@id`),
      listSessions: this.db.prepare(`
        SELECT * FROM sessions ORDER BY started_at DESC LIMIT @limit
      `),
      listSessionsWithFailureCounts: this.db.prepare(`
        SELECT
          s.*,
          COALESCE((
            SELECT COUNT(*) FROM chunks c
            WHERE c.session_id = s.id
              AND c.state = 'failed_permanent'
              AND c.last_error_class IN ('network','timeout','rate_limit','server_5xx','unknown')
          ), 0) AS failed_count
        FROM sessions s
        ORDER BY s.started_at DESC
        LIMIT @limit
      `),
      deleteSession: this.db.prepare(`DELETE FROM sessions WHERE id=@id`),
      autoEndStaleSleepPaused: this.db.prepare(`
        UPDATE sessions
        SET status='ended', ended_at=@now, end_reason='sleep_timeout'
        WHERE status='paused_by_sleep' AND started_at < @threshold
      `),
      autoEndStaleDeviceLossPaused: this.db.prepare(`
        UPDATE sessions
        SET status='ended', ended_at=@now, end_reason='device_lost_timeout'
        WHERE status='paused_by_device_loss' AND started_at < @threshold
      `),

      // ── chunks ──
      insertChunk: this.db.prepare(`
        INSERT INTO chunks (
          id, session_id, idx, source, file_path,
          start_ms, end_ms, overlap_prefix_ms, duration_ms, bytes, sha256,
          state, attempts, next_attempt_at,
          device_boundary, sleep_boundary,
          created_at, updated_at
        ) VALUES (
          @id, @session_id, @idx, @source, @file_path,
          @start_ms, @end_ms, @overlap_prefix_ms, @duration_ms, @bytes, @sha256,
          @state, 0, NULL,
          @device_boundary, @sleep_boundary,
          @created_at, @updated_at
        )
      `),
      getChunk: this.db.prepare(`SELECT * FROM chunks WHERE id=@id`),
      listChunksForSession: this.db.prepare(`
        SELECT * FROM chunks WHERE session_id=@session_id ORDER BY idx ASC, source ASC
      `),
      pickEligibleChunks: this.db.prepare(`
        SELECT * FROM chunks
        WHERE state IN ('captured','failed_retry')
          AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
        ORDER BY created_at ASC
        LIMIT @limit
      `),

      // ── chunk state transitions (CAS) ──
      markUploading: this.db.prepare(`
        UPDATE chunks SET state='uploading', updated_at=@now, attempts=attempts+1
        WHERE id=@id AND state IN ('captured','failed_retry')
      `),
      markTranscribed: this.db.prepare(`
        UPDATE chunks SET state='transcribed', updated_at=@now
        WHERE id=@id AND state='uploading'
      `),
      markCompleted: this.db.prepare(`
        UPDATE chunks SET state='completed', updated_at=@now
        WHERE id=@id AND state='transcribed'
      `),
      markFailedRetry: this.db.prepare(`
        UPDATE chunks
        SET state='failed_retry', updated_at=@now, next_attempt_at=@next_attempt_at,
            last_error_class=@err_class, last_error_msg=@err_msg
        WHERE id=@id AND state='uploading'
      `),
      markFailedPermanent: this.db.prepare(`
        UPDATE chunks
        SET state='failed_permanent', updated_at=@now,
            last_error_class=@err_class, last_error_msg=@err_msg
        WHERE id=@id AND state IN ('uploading','failed_retry')
      `),
      markFailedPermanentFromAny: this.db.prepare(`
        UPDATE chunks
        SET state='failed_permanent', updated_at=@now,
            last_error_class=@err_class, last_error_msg=@err_msg
        WHERE id=@id
      `),

      // ── recovery / sweep ──
      resetStuckUploading: this.db.prepare(`
        UPDATE chunks SET state='captured', updated_at=@now
        WHERE state='uploading' AND updated_at < @threshold
      `),
      findCompleted: this.db.prepare(`SELECT * FROM chunks WHERE state='completed'`),
      findChunksForFileCheck: this.db.prepare(`
        SELECT * FROM chunks
        WHERE file_deleted_at IS NULL
          AND state IN ('captured','uploading','transcribed','failed_retry','failed_permanent')
      `),
      findRetentionDue: this.db.prepare(`
        SELECT * FROM chunks
        WHERE state='failed_permanent' AND file_deleted_at IS NULL AND updated_at < @threshold
      `),
      markFileDeleted: this.db.prepare(`
        UPDATE chunks SET file_deleted_at=@deleted_at WHERE id=@id
      `),

      // ── transcripts ──
      insertTranscript: this.db.prepare(`
        INSERT INTO transcripts (
          chunk_id, text, words_json, provider, model, language, confidence, created_at
        ) VALUES (
          @chunk_id, @text, @words_json, @provider, @model, @language, @confidence, @created_at
        )
      `),
      getTranscript: this.db.prepare(`SELECT * FROM transcripts WHERE chunk_id=@chunk_id`),
      listTranscriptsForSession: this.db.prepare(`
        SELECT t.chunk_id AS chunk_id,
               c.start_ms AS start_ms,
               c.end_ms AS end_ms,
               c.overlap_prefix_ms AS overlap_prefix_ms,
               t.text AS text
        FROM transcripts t
        JOIN chunks c ON c.id = t.chunk_id
        WHERE c.session_id = @session_id
        ORDER BY c.idx ASC, c.source ASC
      `),
      getMaxChunkEndMs: this.db.prepare(`
        SELECT MAX(end_ms) AS max_end_ms FROM chunks WHERE session_id = @session_id
      `),

      // ── mic activity ──
      insertMicActivity: this.db.prepare(`
        INSERT INTO mic_activity_events (occurred_at, state, source_pid, source_bundle, meta)
        VALUES (@occurred_at, @state, @source_pid, @source_bundle, @meta)
      `),
      listMicActivity: this.db.prepare(`
        SELECT * FROM mic_activity_events ORDER BY occurred_at DESC LIMIT @limit
      `),

      // ── retry from failed_permanent (manual user retry) ──
      // RETURNING id is SQLite ≥3.35; better-sqlite3 11+ surfaces it via .all().
      resetFailedToCapturedForSession: this.db.prepare(`
        UPDATE chunks
        SET state='captured', attempts=0, next_attempt_at=NULL, updated_at=@now,
            last_error_class=NULL, last_error_msg=NULL
        WHERE state='failed_permanent'
          AND session_id=@session_id
          AND last_error_class IN ('network','timeout','rate_limit','server_5xx','unknown')
        RETURNING id
      `),
      resetFailedToCapturedAll: this.db.prepare(`
        UPDATE chunks
        SET state='captured', attempts=0, next_attempt_at=NULL, updated_at=@now,
            last_error_class=NULL, last_error_msg=NULL
        WHERE state='failed_permanent'
          AND last_error_class IN ('network','timeout','rate_limit','server_5xx','unknown')
        RETURNING id
      `),
      countFailedChunksForSession: this.db.prepare(`
        SELECT COUNT(*) AS c FROM chunks
        WHERE session_id=@session_id
          AND state='failed_permanent'
          AND last_error_class IN ('network','timeout','rate_limit','server_5xx','unknown')
      `),
      countFailedChunksAll: this.db.prepare(`
        SELECT COUNT(*) AS c FROM chunks
        WHERE state='failed_permanent'
          AND last_error_class IN ('network','timeout','rate_limit','server_5xx','unknown')
      `),
      findMostRecentSessionWithFailures: this.db.prepare(`
        SELECT c.session_id AS session_id
        FROM chunks c
        JOIN sessions s ON s.id = c.session_id
        WHERE c.state='failed_permanent'
          AND c.last_error_class IN ('network','timeout','rate_limit','server_5xx','unknown')
        ORDER BY s.started_at DESC
        LIMIT 1
      `),

      // ── kv ──
      getKv: this.db.prepare(`SELECT v FROM kv WHERE k=@k`),
      setKv: this.db.prepare(`
        INSERT INTO kv (k, v, updated_at) VALUES (@k, @v, @updated_at)
        ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at
      `),
      deleteKv: this.db.prepare(`DELETE FROM kv WHERE k=@k`),
    };
  }
}
