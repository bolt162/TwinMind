import { describe, it, expect, beforeEach } from 'vitest';
import {
  HotkeyGestureRecognizer,
  type HotkeyGestureCallbacks,
  type HotkeyGestureConfig,
  type Scheduler,
  type TimerHandle,
} from '@core/hotkey/HotkeyGestureRecognizer';

/**
 * Fake scheduler: timers are queued and only fire when `advance(ms)` is
 * called. Lets every test enumerate the state space without real timeouts.
 */
class FakeScheduler implements Scheduler {
  private now = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { dueAt: number; fn: () => void }>();

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, { dueAt: this.now + ms, fn });
    return id;
  }
  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }
  /** Move time forward and fire any timers due. */
  advance(ms: number): void {
    this.now += ms;
    // Fire timers in due-order; collect first so we don't iterate a mutating map.
    const due = [...this.timers.entries()]
      .filter(([, t]) => t.dueAt <= this.now)
      .sort((a, b) => a[1].dueAt - b[1].dueAt);
    for (const [id, t] of due) {
      this.timers.delete(id);
      t.fn();
    }
  }
  clockNow(): number {
    return this.now;
  }
}

const CFG: HotkeyGestureConfig = { holdMs: 250, doubleTapGapMs: 350 };

function setup() {
  const sched = new FakeScheduler();
  const calls: string[] = [];
  const cb: HotkeyGestureCallbacks = {
    onHoldStart: () => calls.push('hold-start'),
    onHoldEnd: () => calls.push('hold-end'),
    onSingleTap: () => calls.push('single'),
    onDoubleTap: () => calls.push('double'),
  };
  const r = new HotkeyGestureRecognizer(cb, CFG, sched, () => sched.clockNow());
  return { r, sched, calls };
}

describe('HotkeyGestureRecognizer', () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  it('press-and-hold past threshold fires hold-start then hold-end on release', () => {
    h.r.press();
    h.sched.advance(250); // hold timer fires
    expect(h.calls).toEqual(['hold-start']);
    h.r.release();
    expect(h.calls).toEqual(['hold-start', 'hold-end']);
  });

  it('short tap fires single-tap after the double-tap window', () => {
    h.r.press();
    h.sched.advance(50);
    h.r.release();
    expect(h.calls).toEqual([]); // not yet — waiting on window
    h.sched.advance(349);
    expect(h.calls).toEqual([]); // still inside the window
    h.sched.advance(1); // crosses 350 ms total
    expect(h.calls).toEqual(['single']);
  });

  it('double-tap inside the window fires onDoubleTap on the second release', () => {
    h.r.press();
    h.sched.advance(50);
    h.r.release(); // tap 1
    h.sched.advance(100); // 100 ms gap < 350
    h.r.press();
    h.sched.advance(50);
    h.r.release();
    expect(h.calls).toEqual(['double']);
  });

  it('two taps separated by more than the double-tap window are two single-taps', () => {
    h.r.press();
    h.sched.advance(50);
    h.r.release();
    h.sched.advance(350); // single-tap timer fires here
    expect(h.calls).toEqual(['single']);
    h.r.press();
    h.sched.advance(50);
    h.r.release();
    h.sched.advance(350);
    expect(h.calls).toEqual(['single', 'single']);
  });

  it('held second-tap is treated as a hold, not a double-tap', () => {
    h.r.press();
    h.sched.advance(50);
    h.r.release(); // tap 1 (queued single)
    h.sched.advance(100);
    h.r.press(); // would be tap 2 if released soon; but we'll hold
    h.sched.advance(250); // hold timer fires
    expect(h.calls).toEqual(['hold-start']);
    h.r.release();
    expect(h.calls).toEqual(['hold-start', 'hold-end']);
    // No double, no single.
  });

  it('press during single-tap window cancels the pending single-tap', () => {
    h.r.press();
    h.sched.advance(50);
    h.r.release();
    h.sched.advance(100);
    h.r.press(); // mid-window press cancels the single-tap timer
    h.sched.advance(50);
    h.r.release();
    // The second press → release is a double-tap (within the gap).
    expect(h.calls).toEqual(['double']);
    // And no leftover single-tap fires later.
    h.sched.advance(1000);
    expect(h.calls).toEqual(['double']);
  });

  it('release without a prior press is a no-op', () => {
    h.r.release();
    h.sched.advance(1000);
    expect(h.calls).toEqual([]);
  });

  it('press while already down is a no-op (auto-repeat)', () => {
    h.r.press();
    h.r.press(); // OS auto-repeat — ignore
    h.sched.advance(250);
    expect(h.calls).toEqual(['hold-start']);
    h.r.release();
    expect(h.calls).toEqual(['hold-start', 'hold-end']);
  });

  it('dispose cancels pending timers — no late callbacks', () => {
    h.r.press();
    h.sched.advance(50);
    h.r.release(); // schedules single-tap timer
    h.r.dispose();
    h.sched.advance(1000);
    expect(h.calls).toEqual([]);
  });

  it('dispose mid-hold cancels both the hold timer and the future hold-end', () => {
    h.r.press();
    h.sched.advance(100); // mid-press, no timer fired yet
    h.r.dispose();
    h.sched.advance(1000);
    expect(h.calls).toEqual([]);
    // After dispose, a stray release does nothing.
    h.r.release();
    expect(h.calls).toEqual([]);
  });

  it('hold then a fresh tap a long time later behaves cleanly', () => {
    h.r.press();
    h.sched.advance(250);
    h.r.release();
    expect(h.calls).toEqual(['hold-start', 'hold-end']);
    // Long gap, then a new short tap.
    h.sched.advance(5000);
    h.r.press();
    h.sched.advance(50);
    h.r.release();
    h.sched.advance(350);
    expect(h.calls).toEqual(['hold-start', 'hold-end', 'single']);
  });
});
