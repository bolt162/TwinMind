/**
 * MeetingModeBehavior — chunking policy for meeting sessions.
 *
 * Architecture: §7.5 — pre-mixed (mic + system) mono stream, 2 s overlap, no
 * hard duration cap (sessions can run for hours). Chunk cadence: the first
 * chunk holds 15 s of new audio so the user sees an initial transcript fast,
 * then every subsequent chunk holds 60 s. The overlap-prefix is unchanged
 * (0 for the first chunk, 2 s after) and is independent of chunk length.
 */

import type { ModeBehavior, BehaviorContext } from './ModeBehavior';

/** New-audio target for the first chunk (idx 0) — short, for a fast first transcript. */
export const MEETING_FIRST_CHUNK_INTERVAL_MS = 15_000;
/** New-audio target for every chunk after the first (idx >= 1). */
export const MEETING_CHUNK_INTERVAL_MS = 60_000;
export const MEETING_OVERLAP_MS = 2_000;

export class MeetingModeBehavior implements ModeBehavior {
  readonly mode = 'meeting' as const;
  readonly enableSystemAudio = true;
  readonly enableChunkRotation = true;

  /** No automatic stop — meetings end on user action, sleep, disk-full, etc. */
  shouldForceStop(_elapsedMs: number, _ctx: BehaviorContext): boolean {
    return false;
  }

  chunkRotationIntervalMs(chunkIdx: number): number {
    return chunkIdx === 0 ? MEETING_FIRST_CHUNK_INTERVAL_MS : MEETING_CHUNK_INTERVAL_MS;
  }

  /** All chunks except the first carry the 2 s prefix from the prior chunk. */
  nextChunkOverlapMs(chunkIdx: number): number {
    return chunkIdx === 0 ? 0 : MEETING_OVERLAP_MS;
  }
}
