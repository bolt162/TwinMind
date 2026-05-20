/**
 * IAsrClient — the ASR provider contract.
 *
 * Architecture: §9.1 (interface), §9.2 (Groq impl), §9.6 (auth shape redesigned —
 * each client owns its own credentials; no `authToken` on the request).
 *
 * One method. Easy to mock, easy to swap. The `UploadQueue` only knows this
 * interface and the `AsrError` taxonomy; provider HTTP details stay in the impl.
 */

import type { AsrError } from './AsrError';

export interface WordTiming {
  readonly word: string;
  /** Start offset from the session start (ms). */
  readonly startMs: number;
  /** End offset from the session start (ms). */
  readonly endMs: number;
}

export interface TranscribeRequest {
  /** Absolute path to the chunk's WAV file. */
  readonly audioPath: string;
  /**
   * Session id this chunk belongs to. Passed to providers that thread
   * multiple chunks of the same recording together (e.g. TwinMind's
   * `meeting_id`). Providers that don't need it ignore the field.
   */
  readonly sessionId: string;
  readonly mode: 'dictation' | 'meeting';
  /**
   * `'mic'` for dictation (single stream); `'mixed'` for meeting (mic + system
   * pre-mixed in audio-process). See §7.5.
   */
  readonly source: 'mic' | 'mixed';
  /** Chunk start offset in ms, relative to the session start. */
  readonly startOffsetMs: number;
  /** Chunk end offset in ms, relative to the session start. */
  readonly endOffsetMs: number;
  /** Length of the leading overlap copied from the prior chunk (ms). */
  readonly overlapPrefixMs: number;
  /** BCP-47 language hint, or undefined for auto-detect. */
  readonly language?: string;
  /** Tail of the previous chunk's transcript, used as an ASR priming prompt. */
  readonly contextHint?: string;
}

export interface TranscriptSegment {
  /** Final text for the chunk; may be empty (e.g. VAD-skipped). */
  readonly text: string;
  /** Optional per-word timing in ms, absolute to the session start. */
  readonly words?: WordTiming[];
  /** Provider confidence in [0,1], or undefined when not supplied. */
  readonly confidence?: number;
  readonly provider: string;
  readonly model: string;
  readonly durationMs: number;
  /** BCP-47 language detected by the provider, if any. */
  readonly language?: string;
}

export interface IAsrClient {
  /** Stable identifier persisted on `transcripts.provider`; e.g. `'groq'`. */
  readonly providerName: string;

  /**
   * Transcribe a single chunk. Throws `AsrError` on every failure path so
   * `UploadQueue` can branch on the normalized taxonomy. Should never throw
   * non-`AsrError` exceptions from the happy path; if it does, the queue
   * treats it as `unknown`.
   */
  transcribe(req: TranscribeRequest): Promise<TranscriptSegment>;
}

/** Re-export for callers that just want the error class without two imports. */
export type { AsrError };
