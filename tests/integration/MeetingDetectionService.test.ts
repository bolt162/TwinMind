import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  MEETING_DEBOUNCE_MS,
  MEETING_RESET_QUIET_MS,
  MeetingDetectionService,
} from '@core/meeting/MeetingDetectionService';
import { JobStore } from '@core/storage/JobStore';
import { MIGRATIONS } from '@core/storage/migrations';
import { prepareDatabase } from '@core/storage/Migrator';
import { FakeClock } from '@core/util/Clock';
import type { IMicActivityMonitor } from '@platform/IMicActivityMonitor';

/** Build a stub mic-activity monitor whose listeners are exposed for tests. */
function fakeMonitor() {
  const started = new Set<() => void>();
  const stopped = new Set<() => void>();
  const monitor: IMicActivityMonitor = {
    start: vi.fn(),
    stop: vi.fn(),
    onMicStarted(cb) {
      started.add(cb);
      return () => started.delete(cb);
    },
    onMicStopped(cb) {
      stopped.add(cb);
      return () => stopped.delete(cb);
    },
  };
  return {
    monitor,
    emitStart() {
      for (const cb of started) cb();
    },
    emitStop() {
      for (const cb of stopped) cb();
    },
  };
}

function setup(overrides: Partial<Parameters<typeof MeetingDetectionService>[0]> = {}) {
  const db = new Database(':memory:');
  prepareDatabase(db, MIGRATIONS);
  const clock = new FakeClock(1_700_000_000_000);
  const store = new JobStore(db, clock);
  const f = fakeMonitor();
  const service = new MeetingDetectionService({
    monitor: f.monitor,
    store,
    clock,
    isOnboardingComplete: () => true,
    isOwnCaptureActive: () => false,
    isFeatureEnabled: () => true,
    ...overrides,
  });
  service.start();
  return { service, store, clock, ...f };
}

describe('MeetingDetectionService — debounce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires meeting_detected after MEETING_DEBOUNCE_MS of continuous mic activity', () => {
    const { service, emitStart } = setup();
    const detected = vi.fn();
    service.onMeetingDetected(detected);
    emitStart();
    vi.advanceTimersByTime(MEETING_DEBOUNCE_MS - 1);
    expect(detected).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(detected).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire when mic stops before the debounce window', () => {
    const { service, emitStart, emitStop } = setup();
    const detected = vi.fn();
    service.onMeetingDetected(detected);
    emitStart();
    vi.advanceTimersByTime(MEETING_DEBOUNCE_MS / 2);
    emitStop();
    vi.advanceTimersByTime(MEETING_DEBOUNCE_MS);
    expect(detected).not.toHaveBeenCalled();
  });
});

describe('MeetingDetectionService — suppression rules', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('suppresses when the feature is disabled', () => {
    const { service, emitStart, store } = setup({ isFeatureEnabled: () => false });
    const detected = vi.fn();
    service.onMeetingDetected(detected);
    emitStart();
    vi.advanceTimersByTime(MEETING_DEBOUNCE_MS);
    expect(detected).not.toHaveBeenCalled();
    expect(store.listMicActivityEvents(5).some((e) => e.state === 'suppressed')).toBe(true);
  });

  it('suppresses when onboarding is incomplete', () => {
    const { service, emitStart } = setup({ isOnboardingComplete: () => false });
    const detected = vi.fn();
    service.onMeetingDetected(detected);
    emitStart();
    vi.advanceTimersByTime(MEETING_DEBOUNCE_MS);
    expect(detected).not.toHaveBeenCalled();
  });

  it('suppresses when our own capture is active', () => {
    const { service, emitStart } = setup({ isOwnCaptureActive: () => true });
    const detected = vi.fn();
    service.onMeetingDetected(detected);
    emitStart();
    vi.advanceTimersByTime(MEETING_DEBOUNCE_MS);
    expect(detected).not.toHaveBeenCalled();
  });
});

describe('MeetingDetectionService — per-meeting de-dup', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not re-prompt during a single continuous meeting', () => {
    // No mic-stop happens — the property stays HIGH for the whole call.
    // There's no opportunity for a second debounce/consider cycle, so we
    // get exactly one prompt regardless of how long the meeting runs.
    const { service, emitStart } = setup();
    const detected = vi.fn();
    service.onMeetingDetected(detected);
    emitStart();
    vi.advanceTimersByTime(MEETING_DEBOUNCE_MS);
    expect(detected).toHaveBeenCalledTimes(1);

    // Even much later, with the mic still on, no second prompt fires.
    vi.advanceTimersByTime(MEETING_RESET_QUIET_MS * 5);
    expect(detected).toHaveBeenCalledTimes(1);
  });

  it('suppresses a same-meeting glitch (brief stop+start inside the quiet window)', () => {
    // Models the push-to-talk / mic-route-switch case: the device flips
    // off and on inside the quiet window, so the SAME meeting continues
    // and we must NOT re-prompt.
    const { service, emitStart, emitStop } = setup();
    const detected = vi.fn();
    service.onMeetingDetected(detected);
    emitStart();
    vi.advanceTimersByTime(MEETING_DEBOUNCE_MS);
    expect(detected).toHaveBeenCalledTimes(1);

    // Brief OFF, well under the reset window, then ON again.
    emitStop();
    vi.advanceTimersByTime(MEETING_RESET_QUIET_MS / 2);
    emitStart();
    vi.advanceTimersByTime(MEETING_DEBOUNCE_MS);
    expect(detected).toHaveBeenCalledTimes(1);
  });

  it('prompts again after the mic is quiet long enough to count as a new meeting', () => {
    const { service, emitStart, emitStop } = setup();
    const detected = vi.fn();
    service.onMeetingDetected(detected);
    emitStart();
    vi.advanceTimersByTime(MEETING_DEBOUNCE_MS);
    expect(detected).toHaveBeenCalledTimes(1);

    // Real meeting-end gap: continuous OFF past the reset window.
    emitStop();
    vi.advanceTimersByTime(MEETING_RESET_QUIET_MS);

    // Next mic-start is treated as a fresh meeting.
    emitStart();
    vi.advanceTimersByTime(MEETING_DEBOUNCE_MS);
    expect(detected).toHaveBeenCalledTimes(2);
  });

  it('recordOutcome no longer drives suppression (any outcome behaves the same)', () => {
    // After we removed the cooldown, recordOutcome is purely an
    // activity-log write. Dismissed/accepted/timed_out all behave the
    // same w.r.t. when the next prompt can fire — only the quiet-window
    // de-dup decides that.
    for (const outcome of ['dismissed', 'accepted', 'timed_out'] as const) {
      const { service, emitStart, emitStop } = setup();
      const detected = vi.fn();
      service.onMeetingDetected(detected);

      emitStart();
      vi.advanceTimersByTime(MEETING_DEBOUNCE_MS);
      expect(detected).toHaveBeenCalledTimes(1);
      const promptId = (detected.mock.calls[0]![0] as { promptId: string }).promptId;
      service.recordOutcome(promptId, outcome);

      // Within the quiet window → suppressed regardless of outcome.
      emitStop();
      vi.advanceTimersByTime(MEETING_RESET_QUIET_MS / 2);
      emitStart();
      vi.advanceTimersByTime(MEETING_DEBOUNCE_MS);
      expect(detected, `outcome=${outcome}: same meeting must not re-prompt`).toHaveBeenCalledTimes(1);

      // Past the quiet window → prompts again regardless of outcome.
      emitStop();
      vi.advanceTimersByTime(MEETING_RESET_QUIET_MS);
      emitStart();
      vi.advanceTimersByTime(MEETING_DEBOUNCE_MS);
      expect(detected, `outcome=${outcome}: new meeting must prompt`).toHaveBeenCalledTimes(2);
    }
  });
});
