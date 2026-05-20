/**
 * Migration 0005 — wall-clock time for transcripts (client-captured).
 *
 * The TwinMind backend does not return a per-chunk wall-clock time, so we
 * capture `Date.now()` on the desktop right before POSTing each chunk to
 * the transcribe endpoint and persist that. For meetings, the UI renders
 * "14:02" instead of the relative "MM:SS – MM:SS" range.
 *
 * Why INTEGER (epoch ms) and not a formatted string: keeps formatting +
 * locale concerns entirely in the renderer (toLocaleTimeString), avoids
 * timezone ambiguity, and is the cheapest type for SQLite. NULL on older
 * rows + VAD-skipped chunks; the UI falls back to relative MM:SS in that
 * case so nothing breaks for past data.
 */
export const SQL_V5_TRANSCRIPT_CLOCK_TIME = `
ALTER TABLE transcripts ADD COLUMN clock_time_ms INTEGER;
`;
