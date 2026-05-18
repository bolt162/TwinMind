import { describe, it, expect } from 'vitest';
import { FakeClock, SystemClock } from '@core/util/Clock';

describe('FakeClock', () => {
  it('advances wall and monotonic time by the same delta', () => {
    const c = new FakeClock(1_000, 500n * 1_000_000n);
    c.advance(250);
    expect(c.now()).toBe(1_250);
    expect(c.monotonicNs()).toBe(750n * 1_000_000n);
  });

  it('monotonic time is strictly non-decreasing across advances', () => {
    const c = new FakeClock();
    const before = c.monotonicNs();
    c.advance(10);
    const after = c.monotonicNs();
    expect(after >= before).toBe(true);
  });
});

describe('SystemClock', () => {
  it('returns finite wall-clock and monotonic readings', () => {
    expect(Number.isFinite(SystemClock.now())).toBe(true);
    expect(typeof SystemClock.monotonicNs()).toBe('bigint');
  });

  it('monotonic is non-decreasing across two consecutive reads', () => {
    const a = SystemClock.monotonicNs();
    const b = SystemClock.monotonicNs();
    expect(b >= a).toBe(true);
  });
});
