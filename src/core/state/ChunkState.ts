/**
 * Chunk lifecycle state machine.
 *
 * Architecture: §10.3 (state machine diagram), §11.5 (recovery), §11.6 (data-loss proof).
 *
 * The state machine is enforced in code — any disallowed transition throws
 * `ChunkStateError`, which is the signal that recovery code or a caller has a
 * bug. This is one of the bulkheads that makes "no audio is lost" provable by
 * enumeration: the only way to reach `completed` is through `transcribed`, and
 * the only way to delete an audio file is once `completed` is reached *and* a
 * `transcripts` row exists in the same transaction (see UploadQueue).
 */

export type ChunkState =
  | 'captured'
  | 'uploading'
  | 'transcribed'
  | 'completed'
  | 'failed_retry'
  | 'failed_permanent';

export const CHUNK_STATES: readonly ChunkState[] = [
  'captured',
  'uploading',
  'transcribed',
  'completed',
  'failed_retry',
  'failed_permanent',
] as const;

// Adjacency list of allowed transitions. Anything not in this map is rejected.
// Kept as a `readonly` Map so it can't be mutated at runtime.
const ALLOWED: ReadonlyMap<ChunkState, readonly ChunkState[]> = new Map([
  // Fresh chunk written to disk. UploadQueue may pick it up, or recovery may.
  ['captured', ['uploading'] as const],

  // In flight to the ASR provider.
  // - success → transcribed (then immediately → completed in the same txn)
  // - retryable failure → failed_retry
  // - permanent failure → failed_permanent
  // - crash mid-upload → recovery resets back to captured (this transition
  //   isn't in this map because recovery rewrites the row directly, not via
  //   the FSM; see §11.5).
  ['uploading', ['transcribed', 'failed_retry', 'failed_permanent'] as const],

  // Transcript persisted. The very next step (in the same DB transaction) is
  // → completed + delete the audio file. We model it as a separate state so
  // that a crash between transcribed and completed is recoverable; see §11.5
  // "transcribed but no transcripts row" — that case is impossible because
  // the transcripts row is inserted *before* the state flips here.
  ['transcribed', ['completed'] as const],

  // Will be picked up again when next_attempt_at is in the past.
  ['failed_retry', ['uploading', 'failed_permanent'] as const],

  // Terminal states.
  ['completed', [] as const],
  ['failed_permanent', [] as const],
]);

/** Thrown when code attempts a transition not in the allowed-edges map. */
export class ChunkStateError extends Error {
  /** Construct with the offending `from → to` pair attached for diagnostics. */
  constructor(
    public readonly from: ChunkState,
    public readonly to: ChunkState,
  ) {
    super(`Invalid chunk state transition: ${from} → ${to}`);
    this.name = 'ChunkStateError';
  }
}

/** Return `true` iff `from → to` is an allowed FSM edge. Pure lookup. */
export function canTransition(from: ChunkState, to: ChunkState): boolean {
  return ALLOWED.get(from)?.includes(to) ?? false;
}

/** Throw `ChunkStateError` if `from → to` is not allowed; otherwise no-op. */
export function assertTransition(from: ChunkState, to: ChunkState): void {
  if (!canTransition(from, to)) {
    throw new ChunkStateError(from, to);
  }
}

/** Return `true` if `state` is a terminal (no outgoing transitions). */
export function isTerminal(state: ChunkState): boolean {
  return ALLOWED.get(state)?.length === 0;
}

/**
 * States that the UploadQueue considers eligible for pickup. The queue's SQL
 * predicate must match this set; keep them in sync (and tested in unit).
 */
export const ELIGIBLE_FOR_UPLOAD: ReadonlySet<ChunkState> = new Set([
  'captured',
  'failed_retry',
]);
