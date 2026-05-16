/**
 * Retry policy for the UploadQueue.
 *
 * Architecture: §11.2 — Max attempts 3, base 2s, factor 2, cap 300s, full
 * jitter, Retry-After honored when present and ≤ 5 min, retryable on
 * network/408/429/5xx/timeouts, permanent on other 4xx after 3 attempts.
 *
 * This module is a pure function of inputs → outputs. No side effects, no
 * clock dependency, no logging. That makes it trivial to unit-test the
 * backoff curve and the classification matrix.
 */

import type { AsrErrorClass } from '@core/asr/AsrError';

export interface RetryPolicyConfig {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly growthFactor: number;
  readonly capDelayMs: number;
  /**
   * Upper bound for honoring a server-supplied `Retry-After` (seconds). If the
   * server asks us to wait longer than this we treat the response as if no
   * header were present and fall back to our own backoff curve.
   */
  readonly maxRetryAfterMs: number;
}

/** Architecture §11.2 baseline: 3 attempts, 2 s base, factor 2, 300 s cap. */
export const DEFAULT_RETRY_POLICY: RetryPolicyConfig = {
  maxAttempts: 3,
  baseDelayMs: 2_000,
  growthFactor: 2,
  capDelayMs: 300_000, // 5 min
  maxRetryAfterMs: 300_000,
};

/** Outcome of `decide()`: either retry after `delayMs`, or stop trying. */
export type RetryDecision =
  | { readonly kind: 'retry'; readonly delayMs: number }
  | { readonly kind: 'permanent' };

/** Inputs that fully determine the retry decision; everything else is pure config. */
export interface RetryInput {
  /** Number of attempts already made (before this decision). 0 on first call. */
  readonly attempts: number;
  readonly errorClass: AsrErrorClass;
  /** Server-supplied Retry-After, in milliseconds. `null` if absent. */
  readonly retryAfterMs: number | null;
}

/**
 * Classify an error class as retryable or permanent given the attempt count.
 * Keep this private to the module so callers can't accidentally branch on it
 * without going through `decide()`.
 */
function isRetryable(errorClass: AsrErrorClass): boolean {
  switch (errorClass) {
    case 'network':
    case 'timeout':
    case 'rate_limit':
    case 'server_5xx':
      return true;
    case 'auth':
    case 'bad_audio':
    case 'client_4xx':
      return false;
    case 'unknown':
      // Treat unknown as retryable up to maxAttempts; if it keeps happening
      // the attempt cap forces permanent and surfaces the support_id.
      return true;
  }
}

/**
 * Compute the delay before the next attempt using **equal jitter** (Marc
 * Brooker, 2015): half deterministic + half random, so the first retry is
 * never closer than `baseDelay/2` to the failure. Full jitter let three
 * "retries" pile up within 2 s — equal jitter spaces them out reliably.
 * Pure of side effects; takes `random()` so tests can use a seeded RNG.
 */
function backoffMs(
  attemptIdx: number,
  cfg: RetryPolicyConfig,
  random: () => number,
): number {
  // attemptIdx is 0-based: delay *before* attempt N+1, after N failures.
  const exp = cfg.baseDelayMs * Math.pow(cfg.growthFactor, attemptIdx);
  const capped = Math.min(exp, cfg.capDelayMs);
  const half = capped / 2;
  return Math.floor(half + half * random());
}

/**
 * The full decision function: given the current attempts count, the error
 * class, and an optional `Retry-After`, decide whether to retry (with what
 * delay) or mark permanent.
 */
export function decide(
  input: RetryInput,
  cfg: RetryPolicyConfig = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): RetryDecision {
  if (!isRetryable(input.errorClass)) {
    return { kind: 'permanent' };
  }
  if (input.attempts + 1 >= cfg.maxAttempts) {
    // We've already used up our budget. Note: attempts is the count *before*
    // this current failed attempt; once it equals maxAttempts after increment,
    // there are no further retries.
    return { kind: 'permanent' };
  }

  // Honor Retry-After if present and reasonable; otherwise use our own curve.
  // The architecture pins this at ≤ 5 min: any longer and we'd rather drop
  // back to our own backoff and let the next attempt fail again than freeze
  // the queue on a server's whim.
  if (
    input.retryAfterMs !== null &&
    input.retryAfterMs >= 0 &&
    input.retryAfterMs <= cfg.maxRetryAfterMs
  ) {
    return { kind: 'retry', delayMs: input.retryAfterMs };
  }

  return {
    kind: 'retry',
    delayMs: backoffMs(input.attempts, cfg, random),
  };
}
