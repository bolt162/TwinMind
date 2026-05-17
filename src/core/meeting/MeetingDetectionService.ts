/**
 * MeetingDetectionService — debounce + cooldown + suppression layer on top of
 * an `IMicActivityMonitor`.
 *
 * Architecture: §8.3 — full rules:
 *   - Minimum continuous mic-running before considering a meeting: 2.5 s
 *     (long enough to filter Siri / Alfred / browser permission previews,
 *     short enough that joining a Meet feels instant)
 *   - Cooldown after any notification (dismissed or accepted): 30 min
 *   - Suppress while TwinMind is already in a session: always
 *   - Suppress before onboarding completion: always
 *   - Hard kill switch in Settings: defaults to ON (i.e., feature enabled)
 *
 * On a qualified detection, fire `onMeetingDetected` with a stable promptId.
 * Composition wires that to a Notification; the user's response (accept /
 * dismiss / timeout) is recorded back via `recordOutcome`.
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
export const MEETING_COOLDOWN_MS = 30 * 60 * 1000;

export class MeetingDetectionService {
  private readonly emitter = new EventEmitter();
  private readonly logger: Logger;

  /** Set when we receive a `started` event; cleared on `stopped`. */
  private micStartedAt: number | null = null;
  /** Set when we fire a notification; gates further notifications until cooldown. */
  private cooldownUntil = 0;
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
    this.deps.monitor.stop();
  }

  /** Subscribe to qualified meeting detections; composition shows the notification. */
  onMeetingDetected(cb: (e: MeetingDetectedEvent) => void): () => void {
    this.emitter.on('meeting_detected', cb);
    return () => this.emitter.off('meeting_detected', cb);
  }

  /**
   * Record the outcome of a shown notification. Updates the activity log
   * (transparency view in Settings) and starts the cooldown.
   */
  recordOutcome(promptId: string, outcome: MeetingPromptOutcome): void {
    const now = this.deps.clock.now();
    this.cooldownUntil = now + MEETING_COOLDOWN_MS;
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
    // Rule: cooldown still active.
    if (now < this.cooldownUntil) {
      this.recordSuppressed('cooldown', now);
      return;
    }
    // Rule: mic must still be on (the monitor may have stopped in between).
    if (this.micStartedAt === null) {
      this.recordSuppressed('mic_stopped', now);
      return;
    }

    const promptId = randomUUID();
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
