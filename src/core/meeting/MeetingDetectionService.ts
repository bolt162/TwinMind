/**
 * MeetingDetectionService — debounce + per-meeting de-dup + suppression layer
 * on top of an `IMicActivityMonitor`.
 *
 * Architecture: §8.3 — full rules:
 *   - Minimum continuous mic-running before considering a meeting: 2.5 s
 *     (long enough to filter Siri / Alfred / browser permission previews,
 *     short enough that joining a Meet feels instant)
 *   - At most one prompt per "meeting" — once we notify, further detections
 *     for the same ongoing meeting are suppressed until the mic has been
 *     continuously OFF for `MEETING_RESET_QUIET_MS`. That window absorbs
 *     brief device re-acquisition glitches (push-to-talk, mic-route switch
 *     from MacBook → AirPods, app lifecycle blips) without re-prompting,
 *     while still treating a real meeting-end gap as a new meeting.
 *   - Suppress while TwinMind is already in a session: always
 *   - Suppress before onboarding completion: always
 *   - Hard kill switch in Settings: defaults to ON (i.e., feature enabled)
 *
 * On a qualified detection, fire `onMeetingDetected` with a stable promptId.
 * Composition wires that to a Notification; the user's response (accept /
 * dismiss / timeout) is recorded back via `recordOutcome` purely as an
 * activity-log entry (suppression no longer depends on the outcome).
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IMicActivityMonitor } from '@platform/IMicActivityMonitor';
import type { JobStore } from '@core/storage/JobStore';
import type { Clock } from '@core/util/Clock';
import { type Logger, noopLogger } from '@core/observability/Logger';

export interface MeetingDetectionServiceDeps {
  readonly monitor: IMicActivityMonitor;
  readonly store: JobStore;
  readonly clock: Clock;
  /** Predicates injected from composition so this service stays UI-agnostic. */
  readonly isOnboardingComplete: () => boolean;
  readonly isOwnCaptureActive: () => boolean;
  readonly isFeatureEnabled: () => boolean;
  readonly logger?: Logger;
}

export interface MeetingDetectedEvent {
  readonly promptId: string;
  /** Wall-clock ms at which the mic first qualified (after debounce). */
  readonly qualifiedAt: number;
}

export type MeetingPromptOutcome = 'accepted' | 'dismissed' | 'timed_out';

export const MEETING_DEBOUNCE_MS = 2_500;
/**
 * Continuous mic-OFF span required to consider the next mic-start a NEW
 * meeting (and therefore eligible for a fresh prompt). One minute is a
 * heuristic: longer than the typical device-acquire glitch / push-to-talk
 * release / mic-route switch, shorter than the gap between back-to-back
 * real meetings. Tunable; see §8.3.
 */
export const MEETING_RESET_QUIET_MS = 60_000;

export class MeetingDetectionService {
  private readonly emitter = new EventEmitter();
  private readonly logger: Logger;

  /** Set when we receive a `started` event; cleared on `stopped`. */
  private micStartedAt: number | null = null;
  /**
   * True once we've fired `meeting_detected` for the current meeting. Stays
   * true across brief mic stop+start cycles (so device glitches don't
   * re-prompt) and only resets when the mic stays OFF for the full
   * `MEETING_RESET_QUIET_MS` window (the `quietTimer` handles that).
   */
  private currentMeetingPrompted = false;
  /**
   * Armed on `mic_stopped`, cancelled on `mic_started`. When it fires we
   * treat the meeting as ended → reset `currentMeetingPrompted` so the
   * next debounce-qualified mic-start fires a fresh prompt.
   */
  private quietTimer: NodeJS.Timeout | null = null;
  /** Timer that fires after the debounce window if the mic is still running. */
  private debounceTimer: NodeJS.Timeout | null = null;
  /** Active subscriptions on the activity monitor; cleaned up in stop(). */
  private unsubs: Array<() => void> = [];

  /** Construct with deps; does NOT subscribe until `start()` is called. */
  constructor(private readonly deps: MeetingDetectionServiceDeps) {
    this.logger = deps.logger ?? noopLogger;
  }

  /** Begin listening to the activity monitor. Composition calls this at app ready. */
  start(): void {
    this.unsubs.push(this.deps.monitor.onMicStarted(() => this.onMicStarted()));
    this.unsubs.push(this.deps.monitor.onMicStopped(() => this.onMicStopped()));
    this.deps.monitor.start();
  }

  /** Tear down the subscriptions; called at app quit. */
  stop(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
      this.quietTimer = null;
    }
    this.deps.monitor.stop();
  }

  /** Subscribe to qualified meeting detections; composition shows the notification. */
  onMeetingDetected(cb: (e: MeetingDetectedEvent) => void): () => void {
    this.emitter.on('meeting_detected', cb);
    return () => this.emitter.off('meeting_detected', cb);
  }

  /**
   * Record the outcome of a shown notification. Purely an activity-log
   * write for the diagnostic transparency view in Settings — outcome no
   * longer influences when the NEXT prompt fires.
   *
   * History: this used to start a 30-minute cooldown on 'dismissed' (and
   * earlier, on every outcome). Both versions over-suppressed: a user who
   * dismissed once would miss every meeting for 30 min, even across calls
   * with different people. De-dup is now per-meeting via the quiet-timer
   * mechanism (see class doc), so a dismiss does not block future meetings
   * and an unrelated next meeting prompts as expected.
   */
  recordOutcome(promptId: string, outcome: MeetingPromptOutcome): void {
    const now = this.deps.clock.now();
    this.deps.store.recordMicActivityEvent({
      occurred_at: now,
      state: outcome === 'accepted' ? 'accepted' : outcome === 'dismissed' ? 'dismissed' : 'stopped',
      meta: JSON.stringify({ promptId, outcome }),
    });
  }

  // ─── internal ────────────────────────────────────────────────────────────

  private onMicStarted(): void {
    const now = this.deps.clock.now();
    this.micStartedAt = now;
    this.deps.store.recordMicActivityEvent({
      occurred_at: now,
      state: 'started',
    });

    // The mic is on again — cancel any pending quiet-reset. This is what
    // lets a brief stop+start inside one meeting NOT reset the
    // per-meeting prompt flag.
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
      this.quietTimer = null;
    }

    // Start the debounce timer. If the mic stays on for the full window AND
    // every suppression check passes at that point, we fire a detection.
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.consider(), MEETING_DEBOUNCE_MS);
  }

  private onMicStopped(): void {
    const now = this.deps.clock.now();
    this.deps.store.recordMicActivityEvent({
      occurred_at: now,
      state: 'stopped',
    });
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.micStartedAt = null;

    // Arm the quiet-reset timer. If the mic stays OFF long enough we treat
    // the next mic-start as a NEW meeting and allow a fresh prompt. If a
    // start arrives first, `onMicStarted` cancels this timer and the flag
    // stays set (same meeting continues).
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null;
      this.currentMeetingPrompted = false;
    }, MEETING_RESET_QUIET_MS);
  }

  /** Evaluate every suppression rule and, if all pass, emit the detection. */
  private consider(): void {
    this.debounceTimer = null;
    const now = this.deps.clock.now();

    // Rule: hard kill switch.
    if (!this.deps.isFeatureEnabled()) {
      this.recordSuppressed('feature_off', now);
      return;
    }
    // Rule: onboarding gate.
    if (!this.deps.isOnboardingComplete()) {
      this.recordSuppressed('onboarding_incomplete', now);
      return;
    }
    // Rule: we are the capturing app.
    if (this.deps.isOwnCaptureActive()) {
      this.recordSuppressed('own_capture', now);
      return;
    }
    // Rule: already prompted for this meeting (resets after a quiet gap).
    if (this.currentMeetingPrompted) {
      this.recordSuppressed('same_meeting', now);
      return;
    }
    // Rule: mic must still be on (the monitor may have stopped in between).
    if (this.micStartedAt === null) {
      this.recordSuppressed('mic_stopped', now);
      return;
    }

    const promptId = randomUUID();
    this.currentMeetingPrompted = true;
    this.deps.store.recordMicActivityEvent({
      occurred_at: now,
      state: 'notified',
      meta: JSON.stringify({ promptId }),
    });
    this.emitter.emit('meeting_detected', {
      promptId,
      qualifiedAt: this.micStartedAt,
    } satisfies MeetingDetectedEvent);
    this.logger.info('meeting detected', { promptId });
  }

  private recordSuppressed(reason: string, at: number): void {
    this.deps.store.recordMicActivityEvent({
      occurred_at: at,
      state: 'suppressed',
      meta: JSON.stringify({ reason }),
    });
  }
}
