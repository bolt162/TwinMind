/**
 * Migration 0004 — wall-clock time for transcripts.
 *
 * The TwinMind backend's `/transcribe/choose` response includes a locale-
 * formatted wall-clock string in `start_time_local` (e.g. `"02/06/2026,
 * 13:30:48"`). For meetings the UI shows the time of day rather than a
 * relative offset, so we persist the backend's string verbatim and slice
 * the HH:MM portion at render time.
 *
 * Why TEXT and not INTEGER ms: the backend formats per the deployment's
 * locale, and we don't want to round-trip it through Date parsing — extra
 * complexity for a value the renderer only displays.
 *
 * Existing rows get NULL — the UI falls back to the relative MM:SS format
 * it used before this migration.
 */
export const SQL_V4_TRANSCRIPT_CLOCK_TIME = `
ALTER TABLE transcripts ADD COLUMN clock_time_local TEXT;
`;
