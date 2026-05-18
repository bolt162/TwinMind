import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RETRY_POLICY,
  decide,
  type RetryInput,
} from '@core/queue/RetryPolicy';

// Deterministic "random" so the backoff curve is exact in tests. Under
// equal jitter, random()=1 returns the full ceiling; random()=0 returns
// the floor (half of the ceiling).
const noJitter = () => 1; // returns the maximum: delay = full = base * 2^idx
const halfJitter = () => 0.5;
const minJitter = () => 0;

function input(over: Partial<RetryInput> = {}): RetryInput {
  return {
    attempts: 0,
    errorClass: 'server_5xx',
    retryAfterMs: null,
    ...over,
  };
}

describe('RetryPolicy.decide', () => {
  it('classifies non-retryable errors as permanent immediately', () => {
    for (const errorClass of ['auth', 'bad_audio', 'client_4xx'] as const) {
      expect(decide(input({ errorClass })).kind).toBe('permanent');
    }
  });

  it('classifies retryable errors as retry on first failure', () => {
    for (const errorClass of [
      'network',
      'timeout',
      'rate_limit',
      'server_5xx',
      'unknown',
    ] as const) {
      const d = decide(input({ errorClass }), DEFAULT_RETRY_POLICY, noJitter);
      expect(d.kind).toBe('retry');
    }
  });

  it('exhausts retries after maxAttempts', () => {
    // attempts=2 means we've already had two failures; one more makes 3 which
    // equals the max. The next decision must be permanent.
    expect(decide(input({ attempts: 2 })).kind).toBe('permanent');
    // attempts=0 → still has budget.
    expect(decide(input({ attempts: 0 }), DEFAULT_RETRY_POLICY, noJitter).kind).toBe(
      'retry',
    );
  });

  it('produces an exponential backoff curve at the ceiling (random=1)', () => {
    // Equal-jitter ceiling matches the deterministic curve: 2_000, 4_000, …
    const d0 = decide(input({ attempts: 0 }), DEFAULT_RETRY_POLICY, noJitter);
    const d1 = decide(input({ attempts: 1 }), DEFAULT_RETRY_POLICY, noJitter);
    expect(d0).toEqual({ kind: 'retry', delayMs: 2_000 });
    expect(d1).toEqual({ kind: 'retry', delayMs: 4_000 });
  });

  it('floors at half the ceiling (random=0): first retry never lands too soon', () => {
    const d0 = decide(input({ attempts: 0 }), DEFAULT_RETRY_POLICY, minJitter);
    const d1 = decide(input({ attempts: 1 }), DEFAULT_RETRY_POLICY, minJitter);
    expect(d0).toEqual({ kind: 'retry', delayMs: 1_000 });
    expect(d1).toEqual({ kind: 'retry', delayMs: 2_000 });
  });

  it('caps the delay at capDelayMs', () => {
    const cfg = { ...DEFAULT_RETRY_POLICY, maxAttempts: 100, capDelayMs: 300_000 };
    const d = decide(input({ attempts: 50 }), cfg, noJitter);
    expect(d).toEqual({ kind: 'retry', delayMs: 300_000 });
  });

  it('applies equal jitter linearly (random=0.5 → 3/4 of ceiling)', () => {
    // attempts=1, ceiling=4_000, equal jitter at random=0.5: 2000 + 2000*0.5 = 3000
    const d = decide(input({ attempts: 1 }), DEFAULT_RETRY_POLICY, halfJitter);
    expect(d).toEqual({ kind: 'retry', delayMs: 3_000 });
  });

  it('honors Retry-After when within bounds', () => {
    const d = decide(
      input({ errorClass: 'rate_limit', retryAfterMs: 15_000 }),
      DEFAULT_RETRY_POLICY,
      noJitter,
    );
    expect(d).toEqual({ kind: 'retry', delayMs: 15_000 });
  });

  it('ignores Retry-After larger than maxRetryAfterMs and falls back to backoff', () => {
    const d = decide(
      input({ errorClass: 'rate_limit', retryAfterMs: 600_000 }),
      DEFAULT_RETRY_POLICY,
      noJitter,
    );
    // Falls back to our own curve at attempts=0 → 2_000 ms.
    expect(d).toEqual({ kind: 'retry', delayMs: 2_000 });
  });

  it('ignores negative Retry-After (server bug) and falls back to backoff', () => {
    const d = decide(
      input({ errorClass: 'rate_limit', retryAfterMs: -1 }),
      DEFAULT_RETRY_POLICY,
      noJitter,
    );
    expect(d).toEqual({ kind: 'retry', delayMs: 2_000 });
  });
});
