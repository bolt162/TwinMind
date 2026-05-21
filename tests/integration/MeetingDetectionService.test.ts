import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  MEETING_COOLDOWN_MS,
  MEETING_DEBOUNCE_MS,
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

describe('MeetingDetectionService — cooldown', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('suppresses a second detection within the cooldown window', () => {
    const { service, emitStart, emitStop, clock } = setup();
    const detected = vi.fn();
    service.onMeetingDetected(detected);
    emitStart();
    vi.advanceTimersByTime(MEETING_DEBOUNCE_MS);
    expect(detected).toHaveBeenCalledTimes(1);

    // User dismisses → cooldown starts.
    const promptId = (detected.mock.calls[0]![0] as { promptId: string }).promptId;
    service.recordOutcome(promptId, 'dismissed');

    // 1 minute later, mic comes on again; debounce passes; still cooled down.
    emitStop();
    clock.advance(60_000);
    emitStart();
    vi.advanceTimersByTime(MEETING_DEBOUNCE_MS);
    expect(detected).toHaveBeenCalledTimes(1);

    // After the cooldown expires, a new mic activity does qualify.
    emitStop();
    clock.advance(MEETING_COOLDOWN_MS);
    emitStart();
    vi.advanceTimersByTime(MEETING_DEBOUNCE_MS);
    expect(detected).toHaveBeenCalledTimes(2);
  });

  it('does NOT start a cooldown when the outcome is accepted', () => {
    const { service, emitStart, emitStop } = setup();
    const detected = vi.fn();
    service.onMeetingDetected(detected);
    emitStart();
    vi.advanceTimersByTime(MEETING_DEBOUNCE_MS);
    expect(detected).toHaveBeenCalledTimes(1);

    // User accepts (started the recording). Cooldown must NOT engage —
    // accepted is not a "leave me alone" signal.
    const promptId = (detected.mock.calls[0]![0] as { promptId: string }).promptId;
    service.recordOutcome(promptId, 'accepted');

    // Immediate next meeting (e.g. user finished one call, jumped to another)
    // should prompt without waiting 30 min.
    emitStop();
    emitStart();
    vi.advanceTimersByTime(MEETING_DEBOUNCE_MS);
    expect(detected).toHaveBeenCalledTimes(2);
  });

  it('does NOT start a cooldown when the outcome is timed_out', () => {
    const { service, emitStart, emitStop } = setup();
    const detected = vi.fn();
    service.onMeetingDetected(detected);
    emitStart();
    vi.advanceTimersByTime(MEETING_DEBOUNCE_MS);
    expect(detected).toHaveBeenCalledTimes(1);

    // The notification timed out (60 s passed with no user interaction).
    // Treat as no-preference signal — next meeting should still prompt.
    const promptId = (detected.mock.calls[0]![0] as { promptId: string }).promptId;
    service.recordOutcome(promptId, 'timed_out');

    emitStop();
    emitStart();
    vi.advanceTimersByTime(MEETING_DEBOUNCE_MS);
    expect(detected).toHaveBeenCalledTimes(2);
  });
});
