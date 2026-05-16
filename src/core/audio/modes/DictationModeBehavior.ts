/**
 * DictationModeBehavior — chunking policy for dictation sessions.
 *
 * Architecture: §7.4 — single growing WAV, no system audio, no overlap,
 * 5-minute hard cap. The hotkey-release stop path closes the chunk and
 * pastes the transcript into the active app.
 */

import type { ModeBehavior, BehaviorContext } from './ModeBehavior';

export const DICTATION_HARD_CAP_MS = 5 * 60 * 1000;

export class DictationModeBehavior implements ModeBehavior {
  readonly mode = 'dictation' as const;
  /** Single chunk = no auto-rotation. */
  readonly enableSystemAudio = false;
  readonly enableChunkRotation = false;

  /** Inspect the elapsed-time hook: at the cap, force a stop. */
  shouldForceStop(elapsedMs: number, _ctx: BehaviorContext): boolean {
    return elapsedMs >= DICTATION_HARD_CAP_MS;
  }

  /** Dictation is a one-chunk session; the rotation interval is never used. */
  chunkRotationIntervalMs(): number {
    return Number.POSITIVE_INFINITY;
  }

  /** Always zero — there's no prior chunk to overlap with. */
  nextChunkOverlapMs(_chunkIdx: number): number {
    return 0;
  }
}
