/**
 * ModeBehavior — strategy interface for dictation vs meeting.
 *
 * Architecture: §19 ("Strategy: DictationModeBehavior vs MeetingModeBehavior
 * in RecordingOrchestrator — mode-specific differences (chunking, overlap,
 * system audio) without conditionals scattered").
 */

export interface BehaviorContext {
  /** Wall-time at session start (epoch ms from Clock.now). */
  readonly sessionStartedAt: number;
  /** Current chunk index within the session (0-based). */
  readonly chunkIdx: number;
}

export interface ModeBehavior {
  readonly mode: 'dictation' | 'meeting';
  /** Should the system-audio source be enabled in this mode? */
  readonly enableSystemAudio: boolean;
  /** Does the orchestrator rotate chunks on a timer? */
  readonly enableChunkRotation: boolean;

  /** Force-stop predicate evaluated each chunk-rotation tick. */
  shouldForceStop(elapsedMs: number, ctx: BehaviorContext): boolean;

  /** Interval between chunk-rotation events when `enableChunkRotation` is true. */
  chunkRotationIntervalMs(): number;

  /** Overlap-prefix to pass to the audio-process for the chunk at `chunkIdx`. */
  nextChunkOverlapMs(chunkIdx: number): number;
}
