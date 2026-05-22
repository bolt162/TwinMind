/**
 * Shared transcript→clipboard formatter. Used by both SessionDetail (where
 * chunks are already in hand) and SessionsList (where the row's Copy button
 * fetches chunks lazily on click). Keeping a single source of truth so the
 * copied output stays consistent across the two entry points.
 */

export interface ClipboardTranscriptChunk {
  startMs: number;
  overlapPrefixMs: number;
  text: string;
}

/** Format epoch ms as 24-hour `HH:MM` in the user's locale (e.g. "14:02"). */
export function formatClockHHMM(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Format a chunk list as `[HH:MM] text\n\n[HH:MM] text…`. The HH:MM is
 * derived from `sessionStartedAt + chunk.start_ms + overlap` so it matches
 * what the on-screen transcript shows. Empty / VAD-skipped chunks are
 * filtered out so the output isn't littered with timestamps and no text.
 */
export function formatTranscriptForClipboard(
  items: ReadonlyArray<ClipboardTranscriptChunk>,
  sessionStartedAt: number,
): string {
  return items
    .filter((t) => t.text.trim().length > 0)
    .map((t) => {
      const hhmm = formatClockHHMM(sessionStartedAt + t.startMs + t.overlapPrefixMs);
      return `[${hhmm}] ${t.text.trim()}`;
    })
    .join('\n\n');
}
