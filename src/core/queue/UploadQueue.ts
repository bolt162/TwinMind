/**
 * UploadQueue — the outbox tick loop.
 *
 * Architecture: §11.1 (outbox), §11.2 (retry policy), §11.3 (offline =
 * "transient failure, same path"), §11.4 (error surfacing). The queue is the
 * only path from a captured chunk to an external network call; there is no
 * bypass for "send now" or "skip the queue."
 *
 * Loop shape:
 *   1. Tick on an interval (default 1 s) when running.
 *   2. Each tick: pick `maxConcurrency - inFlight` eligible rows from JobStore.
 *   3. For each, transition to `uploading`, call `IAsrClient.transcribe`.
 *   4. On success → transcript + completed in one txn + post-commit file unlink.
 *   5. On AsrError → RetryPolicy.decide → `failed_retry` (with backoff) or `failed_permanent`.
 *   6. Anything else → classify as `unknown`, same RetryPolicy path.
 *
 * Crash safety: every state change goes through JobStore CAS UPDATEs so an
 * abrupt process exit leaves the row in a state RecoveryService can repair.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';

import { AsrError } from '@core/asr/AsrError';
import type { IAsrClient, TranscriptSegment } from '@core/asr/IAsrClient';
import type { ChunkRow, JobStore } from '@core/storage/JobStore';
import type { Clock } from '@core/util/Clock';
import { type RetryPolicyConfig, DEFAULT_RETRY_POLICY, decide } from './RetryPolicy';
import { type Logger, noopLogger } from '@core/observability/Logger';

export interface UploadQueueOptions {
  /** Cap on in-flight uploads. Architecture §11.2 default: 2. */
  readonly maxConcurrency?: number;
  /** Tick interval when there could be eligible work. Default 1 s. */
  readonly tickIntervalMs?: number;
  /** Retry curve and limits; defaults to DEFAULT_RETRY_POLICY. */
  readonly retryPolicy?: RetryPolicyConfig;
}

export interface ChunkCompletedEvent {
  readonly chunkId: string;
  readonly sessionId: string;
  readonly segment: TranscriptSegment;
}

export interface ChunkFailedRetryEvent {
  readonly chunkId: string;
  readonly nextAttemptAt: number;
  readonly errorClass: string;
}

export interface ChunkFailedPermanentEvent {
  readonly chunkId: string;
  readonly errorClass: string;
}

export class UploadQueue {
  private readonly maxConcurrency: number;
  private readonly tickIntervalMs: number;
  private readonly retryPolicy: RetryPolicyConfig;
  private readonly emitter = new EventEmitter();

  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = 0;
  /** In-flight promises tracked so `stop()` can drain cleanly. */
  private readonly pending = new Set<Promise<void>>();

  /** Configure with the store, ASR client, clock, and queue options. */
  constructor(
    private readonly store: JobStore,
    private readonly asr: IAsrClient,
    private readonly clock: Clock,
    options: UploadQueueOptions = {},
    private readonly logger: Logger = noopLogger,
  ) {
    this.maxConcurrency = options.maxConcurrency ?? 2;
    this.tickIntervalMs = options.tickIntervalMs ?? 1_000;
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
  }

  /** Begin the tick loop. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    // Fire one tick immediately so callers don't wait a full interval on launch.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.tickIntervalMs);
    // setInterval handle keeps the event loop alive; in main process that's fine.
    // For tests, callers can use the manual `tick()` API and pass a tiny interval.
  }

  /** Stop the tick loop and wait for in-flight uploads to finish. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Drain. New tasks may be added while we wait (a final tick that started just
    // before stop), so loop until the set is truly empty.
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  /**
   * One scheduling cycle. Picks up to `maxConcurrency - inFlight` chunks and
   * fires off their uploads in parallel. Returns immediately; the promises
   * themselves are tracked in `pending` for `stop()`.
   */
  async tick(): Promise<void> {
    if (!this.running) return;
    const slots = this.maxConcurrency - this.inFlight;
    if (slots <= 0) return;
    const chunks = this.store.pickEligibleChunks(this.clock.now(), slots);
    for (const chunk of chunks) {
      const p = this.processChunk(chunk);
      this.pending.add(p);
      // Always-resolve cleanup so a thrown error doesn't leave us leaking entries.
      p.finally(() => this.pending.delete(p)).catch(() => {});
    }
  }

  /** Subscribe to per-chunk lifecycle events used to push updates to the renderer. */
  on(event: 'chunk_completed', cb: (e: ChunkCompletedEvent) => void): void;
  on(event: 'chunk_failed_retry', cb: (e: ChunkFailedRetryEvent) => void): void;
  on(event: 'chunk_failed_permanent', cb: (e: ChunkFailedPermanentEvent) => void): void;
  // The implementation signature uses `any` for the callback parameter so the
  // narrower overload callbacks above remain assignable. Callers see only the
  // overloads, never this signature.
  on(event: string, cb: (e: any) => void): void {
    this.emitter.on(event, cb);
  }

  /** Test/diagnostic accessor: number of currently in-flight uploads. */
  get inFlightCount(): number {
    return this.inFlight;
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  /** Pick a chunk up, attempt transcription, persist the outcome. */
  private async processChunk(chunk: ChunkRow): Promise<void> {
    this.inFlight++;
    try {
      // Step 1: CAS into `uploading`. If it fails the chunk was concurrently
      // mutated (recovery reset it, or another tick grabbed it first). Either
      // way, no-op for this tick — let the next one pick the right state.
      try {
        this.store.recordChunkUploadStart(chunk.id);
      } catch {
        return;
      }

      // Anchor for the chunk's wall-clock window. Computed from session
      // start + chunk offset (NOT Date.now() at upload) so the values are
      // correct even when the queue is delayed (offline + retry, crash
      // recovery, etc.). The session row exists because chunks cascade-
      // delete with their session — but we still guard defensively.
      const session = this.store.getSession(chunk.session_id);
      if (!session) {
        this.store.recordChunkPermanentFailure(chunk.id, 'unknown', 'session_missing');
        return;
      }
      const chunkWallClockStartMs = session.started_at + chunk.start_ms;
      const chunkWallClockEndMs = session.started_at + chunk.end_ms;

      // Step 2: actually transcribe. AsrError instances are expected failure
      // signals; anything else is a programmer bug we'll classify as 'unknown'.
      let segment: TranscriptSegment;
      try {
        segment = await this.asr.transcribe({
          audioPath: chunk.file_path,
          sessionId: chunk.session_id,
          // Source unambiguously implies mode: `mic` = dictation; `mixed` = meeting.
          mode: chunk.source === 'mic' ? 'dictation' : 'meeting',
          source: chunk.source,
          startOffsetMs: chunk.start_ms,
          endOffsetMs: chunk.end_ms,
          overlapPrefixMs: chunk.overlap_prefix_ms,
          chunkWallClockStartMs,
          chunkWallClockEndMs,
        });
      } catch (e) {
        this.handleFailure(chunk, e);
        return;
      }

      // Step 3: persist transcript + completed + delete file (atomic in JobStore).
      this.store.recordChunkSuccessAndComplete(
        {
          chunk_id: chunk.id,
          text: segment.text,
          words_json: segment.words ? JSON.stringify(segment.words) : null,
          provider: segment.provider,
          model: segment.model,
          language: segment.language ?? null,
          confidence: segment.confidence ?? null,
          clock_time_ms: segment.clockTimeMs ?? null,
        },
        () => {
          try {
            fs.unlinkSync(chunk.file_path);
          } catch {
            // Best-effort. RecoveryService picks up orphan-completed files on next launch.
          }
        },
      );
      this.emitter.emit('chunk_completed', {
        chunkId: chunk.id,
        sessionId: chunk.session_id,
        segment,
      } satisfies ChunkCompletedEvent);
    } finally {
      this.inFlight--;
    }
  }

  /**
   * Map an upload failure to a JobStore mutation. `AsrError` carries its own
   * taxonomy; anything else falls into `unknown` and gets the same backoff
   * curve until maxAttempts force a permanent classification.
   */
  private handleFailure(chunk: ChunkRow, err: unknown): void {
    let errorClass: AsrError['kind'];
    let retryAfterMs: number | null;
    let message: string;
    if (err instanceof AsrError) {
      errorClass = err.kind;
      retryAfterMs = err.retryAfterMs;
      message = err.message;
    } else {
      errorClass = 'unknown';
      retryAfterMs = null;
      message = err instanceof Error ? err.message : String(err);
    }

    const decision = decide(
      { attempts: chunk.attempts, errorClass, retryAfterMs },
      this.retryPolicy,
    );

    if (decision.kind === 'retry') {
      const nextAttemptAt = this.clock.now() + decision.delayMs;
      this.store.recordChunkRetryableFailure(chunk.id, nextAttemptAt, errorClass, message);
      this.logger.warn('chunk upload failed; will retry', {
        chunkId: chunk.id,
        errorClass,
        nextAttemptAt,
      });
      this.emitter.emit('chunk_failed_retry', {
        chunkId: chunk.id,
        nextAttemptAt,
        errorClass,
      } satisfies ChunkFailedRetryEvent);
    } else {
      this.store.recordChunkPermanentFailure(chunk.id, errorClass, message);
      this.logger.error('chunk upload permanent failure', {
        chunkId: chunk.id,
        errorClass,
      });
      this.emitter.emit('chunk_failed_permanent', {
        chunkId: chunk.id,
        errorClass,
      } satisfies ChunkFailedPermanentEvent);
    }
  }
}
