/**
 * HotkeyGestureRecognizer — turns raw press/release events from a hotkey
 * source into three semantic gestures: hold (press-and-hold), single-tap,
 * and double-tap.
 *
 * Architecture: §5 (composite hotkey source). The recognizer lives behind
 * IHotkeyManager.registerPressRelease — that pipeline already produces
 * `onPress` / `onRelease` events from uiohook. This class lives entirely in
 * @core/ (no Electron deps) so it's pure-logic testable.
 *
 * Gesture decisions:
 *   • PRESS:
 *       - Cancels any pending single-tap timer from a previous cycle. If
 *         that cancel happened within `doubleTapGapMs` of the previous
 *         release, this press is flagged as a `secondTap` candidate.
 *       - Schedules a hold timer for `holdMs`. If we're still holding when
 *         it fires, we enter HOLD mode and call `onHoldStart` synchronously.
 *   • HOLD TIMER FIRES: enter HOLD mode. The pending double-tap is dropped
 *     (a hold takes priority over a double-tap when the user holds tap 2).
 *   • RELEASE:
 *       - If we entered HOLD mode for this press, call `onHoldEnd`.
 *       - Else: cancel the (still-pending) hold timer.
 *           · If `secondTap` was flagged → fire `onDoubleTap` immediately.
 *           · Otherwise → schedule a single-tap timer for `doubleTapGapMs`.
 *             If no new press arrives in that window, fire `onSingleTap`.
 *             If a press DOES arrive, the press handler cancels this timer.
 *
 * Invariants:
 *   - At most one of {holdTimer, singleTapTimer} is set at any time.
 *   - Entering HOLD mode is the only way the next release fires `onHoldEnd`.
 *   - `secondTap` flag is consumed by the next release; it's reset whenever
 *     we enter HOLD mode (so a held second tap doesn't double-fire).
 *
 * Clock: pure (no Date.now). Pass any `() => number` source; in tests use
 * a fake clock so the full state space is enumerable.
 *
 * Scheduler: pure (no setTimeout). Pass a `{ setTimeout, clearTimeout }`
 * pair; in tests use the FakeScheduler in this file's spec.
 */

export interface HotkeyGestureCallbacks {
  /** Press held longer than `holdMs`. Fires on the timer, NOT on release. */
  readonly onHoldStart?: () => void;
  /** Release after a hold; pairs with `onHoldStart` 1:1. */
  readonly onHoldEnd?: () => void;
  /** Single short tap that wasn't the first of a double. Fires after `doubleTapGapMs`. */
  readonly onSingleTap?: () => void;
  /** Two short taps within `doubleTapGapMs`. Fires on the second release. */
  readonly onDoubleTap?: () => void;
}

export interface HotkeyGestureConfig {
  /** Anything held longer is a hold, not a tap. Default 250 ms. */
  readonly holdMs: number;
  /** Max gap between tap1 release and tap2 press to count as a double. Default 350 ms. */
  readonly doubleTapGapMs: number;
}

export const DEFAULT_GESTURE_CONFIG: HotkeyGestureConfig = {
  holdMs: 250,
  doubleTapGapMs: 350,
};

/** Abstraction over setTimeout so tests can drive the clock deterministically. */
export interface Scheduler {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}
export type TimerHandle = unknown;

/** Default scheduler: wraps Node/browser globals. */
export const realScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class HotkeyGestureRecognizer {
  private readonly cfg: HotkeyGestureConfig;
  private readonly scheduler: Scheduler;
  private readonly now: () => number;
  private readonly cb: HotkeyGestureCallbacks;

  /** Set while a press is in flight and we haven't yet decided hold vs tap. */
  private holdTimer: TimerHandle | null = null;
  /** Set after a first short-tap release while we wait for a possible second press. */
  private singleTapTimer: TimerHandle | null = null;
  /** Time the last short-tap was released. Used to validate the next press's gap. */
  private lastReleaseAt: number = -Infinity;
  /** True if the current in-flight press follows the previous release within the gap. */
  private secondTapCandidate = false;
  /** True once `holdMs` has elapsed on the current press and we entered HOLD mode. */
  private inHold = false;
  /** True between press and release so duplicate press events don't double-fire. */
  private isDown = false;

  constructor(
    cb: HotkeyGestureCallbacks,
    cfg: HotkeyGestureConfig = DEFAULT_GESTURE_CONFIG,
    scheduler: Scheduler = realScheduler,
    now: () => number = () => Date.now(),
  ) {
    this.cb = cb;
    this.cfg = cfg;
    this.scheduler = scheduler;
    this.now = now;
  }

  /** Feed a key-press event. Idempotent: a press while already down is ignored. */
  press(): void {
    if (this.isDown) return; // OS auto-repeat or a glitch; ignore.
    this.isDown = true;
    this.inHold = false;

    // If a single-tap timer is pending, this press might be the second of a
    // double-tap. Cancel the timer; if the gap is short enough, flag this
    // press as a second-tap candidate. (If the gap is too long, the timer
    // would have already fired and we wouldn't be in this branch.)
    if (this.singleTapTimer !== null) {
      this.scheduler.clearTimeout(this.singleTapTimer);
      this.singleTapTimer = null;
      if (this.now() - this.lastReleaseAt <= this.cfg.doubleTapGapMs) {
        this.secondTapCandidate = true;
      }
    }

    // Schedule the hold-detection timer. If it fires before release, we
    // transition into HOLD mode and drop any pending double-tap.
    this.holdTimer = this.scheduler.setTimeout(() => {
      this.holdTimer = null;
      this.inHold = true;
      // A held second-tap is treated as a fresh hold, not a double-tap.
      this.secondTapCandidate = false;
      this.cb.onHoldStart?.();
    }, this.cfg.holdMs);
  }

  /** Feed a key-release event. */
  release(): void {
    if (!this.isDown) return; // Spurious release without a matching press.
    this.isDown = false;

    if (this.inHold) {
      // Press exceeded holdMs threshold; we already fired onHoldStart.
      this.inHold = false;
      this.cb.onHoldEnd?.();
      // Reset any tap state — a hold ends the gesture cleanly.
      this.lastReleaseAt = -Infinity;
      return;
    }

    // Short tap: cancel the still-pending hold timer.
    if (this.holdTimer !== null) {
      this.scheduler.clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }

    if (this.secondTapCandidate) {
      // This is the second tap of a double-tap.
      this.secondTapCandidate = false;
      this.lastReleaseAt = -Infinity;
      this.cb.onDoubleTap?.();
      return;
    }

    // First short tap. Schedule the single-tap timer; if it fires without a
    // new press, the gesture is a confirmed single-tap.
    this.lastReleaseAt = this.now();
    this.singleTapTimer = this.scheduler.setTimeout(() => {
      this.singleTapTimer = null;
      this.lastReleaseAt = -Infinity;
      this.cb.onSingleTap?.();
    }, this.cfg.doubleTapGapMs);
  }

  /**
   * Cancel any pending timers + reset all state. Called when the parent
   * hotkey binding is unregistered (e.g., user changed the accelerator).
   * Pending callbacks WILL NOT fire after dispose.
   */
  dispose(): void {
    if (this.holdTimer !== null) {
      this.scheduler.clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    if (this.singleTapTimer !== null) {
      this.scheduler.clearTimeout(this.singleTapTimer);
      this.singleTapTimer = null;
    }
    this.isDown = false;
    this.inHold = false;
    this.secondTapCandidate = false;
    this.lastReleaseAt = -Infinity;
  }
}
