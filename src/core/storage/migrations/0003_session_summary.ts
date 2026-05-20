/**
 * Migration 0003 — per-meeting summary tracking.
 *
 * The TwinMind backend builds the actual summary (the desktop app never
 * stores summary CONTENT, same pattern as V1). All we track locally is:
 *   - whether a summary call has been fired,
 *   - what came back (the backend's `summary_id`),
 *   - and timestamps for diagnostics.
 *
 * `summary_status` lifecycle:
 *   NULL          → not attempted (dictation OR meeting not yet processed).
 *   'pending'     → request in flight.
 *   'completed'   → backend returned 200 + a summary_id. "View Summary"
 *                   button opens `${TWINMIND_APP_URL}/m/${session.id}`.
 *   'failed'      → request errored OR was rolled back from stale 'pending'.
 *                   UI shows "Generate summary" to let the user retry.
 *
 * SQLite supports `ALTER TABLE ADD COLUMN` with CHECK constraints; new rows
 * are validated, existing rows are not (their default NULL is fine).
 */
export const SQL_V3_SESSION_SUMMARY = `
ALTER TABLE sessions ADD COLUMN summary_status TEXT
  CHECK(summary_status IS NULL OR summary_status IN ('pending','completed','failed'));
ALTER TABLE sessions ADD COLUMN summary_id TEXT;
ALTER TABLE sessions ADD COLUMN summary_requested_at INTEGER;
ALTER TABLE sessions ADD COLUMN summary_completed_at INTEGER;
`;
