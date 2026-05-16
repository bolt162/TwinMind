/**
 * MeetingModeBehavior — chunking policy for meeting sessions.
 *
 * Architecture: §7.5 — pre-mixed (mic + system) mono stream, 30 s chunks
 * with 2 s overlap, no hard duration cap (sessions can run for hours).
 */

import type { ModeBehavior, BehaviorContext } from './ModeBehavior';

export const MEETING_CHUNK_INTERVAL_MS = 30_000;
export const MEETING_OVERLAP_MS = 2_000;

export class MeetingModeBehavior implements ModeBehavior {
  readonly mode = 'meeting' as const;
  readonly enableSystemAudio = true;
  readonly enableChunkRotation = true;

  /** No automatic stop — meetings end on user action, sleep, disk-full, etc. */
  shouldForceStop(_elapsedMs: number, _ctx: BehaviorContext): boolean {
    return false;
  }

  chunkRotationIntervalMs(): number {
    return MEETING_CHUNK_INTERVAL_MS;
  }

  /** All chunks except the first carry the 2 s prefix from the prior chunk. */
  nextChunkOverlapMs(chunkIdx: number): number {
    return chunkIdx === 0 ? 0 : MEETING_OVERLAP_MS;
  }
}
