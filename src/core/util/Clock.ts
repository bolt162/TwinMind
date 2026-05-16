/**
 * Injectable clock.
 *
 * Architecture: §5 (Clock owns `now()` and `monotonicNs()`, not retry timing decisions),
 * §7.3 (every PCM buffer is stamped on arrival from the *same* monotonic source so the
 * mic and system streams don't drift relative to each other).
 *
 * Two reasons we don't use `Date.now()` / `process.hrtime.bigint()` directly:
 *   1. Tests need to advance time deterministically (FakeClock).
 *   2. Wall-clock and monotonic clocks have different semantics — wall can jump
 *      backwards on NTP sync; monotonic cannot. Every duration in the audio path
 *      must come from monotonicNs(), never from `now()` deltas.
 */
export interface Clock {
  /** Wall-clock time in epoch milliseconds. Used for DB `created_at`, log timestamps. */
  now(): number;

  /**
   * Monotonic nanoseconds. Strictly non-decreasing, immune to NTP/clock changes.
   * Used for: PCM frame timestamps, retry backoff math, latency metrics.
   */
  monotonicNs(): bigint;
}

/** Production clock backed by `Date.now()` + `process.hrtime.bigint()`. */
export const SystemClock: Clock = {
  now: () => Date.now(),
  monotonicNs: () => process.hrtime.bigint(),
};

/**
 * Test-only clock. `advance()` moves both wall and monotonic time forward by the
 * same delta — fine because tests don't exercise the wall/monotonic divergence.
 */
export class FakeClock implements Clock {
  private wallMs: number;
  private monoNs: bigint;

  /** Construct with initial wall-clock ms and monotonic ns; both default to 0. */
  constructor(initialWallMs = 0, initialMonoNs = 0n) {
    this.wallMs = initialWallMs;
    this.monoNs = initialMonoNs;
  }

  /** Current fake wall-clock time in ms (last set by constructor or `advance`). */
  now(): number {
    return this.wallMs;
  }

  /** Current fake monotonic time in ns. */
  monotonicNs(): bigint {
    return this.monoNs;
  }

  /** Move both wall and monotonic time forward by `ms` milliseconds. */
  advance(ms: number): void {
    this.wallMs += ms;
    this.monoNs += BigInt(ms) * 1_000_000n;
  }
}
