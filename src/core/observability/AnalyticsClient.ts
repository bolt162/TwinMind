/**
 * AnalyticsClient — Amplitude wrapper (opt-in).
 *
 * Architecture: §13.3 — typed event vocabulary, no PII. Renderer forwards
 * events through IPC; only this main-side client actually talks to Amplitude.
 *
 * Opt-in via env: `TWINMIND_AMPLITUDE_KEY`. Without it, the no-op client just
 * logs the event at debug level for local development visibility.
 */

import { type Logger, noopLogger } from './Logger';

/** Allowed event names; mirrors §13.3 table. Add cautiously. */
export type AnalyticsEvent =
  | 'app_launched'
  | 'onboarding_step_completed'
  | 'permission_requested'
  | 'recording_started'
  | 'recording_stopped'
  | 'transcription_succeeded'
  | 'transcription_failed'
  | 'chunk_vad_skipped'
  | 'device_change_during_recording'
  | 'crash_recovery_performed'
  | 'offline_queue_drained'
  | 'mic_activity_detected'
  | 'meeting_notification_shown'
  | 'meeting_notification_outcome'
  | 'meeting_detection_suppressed'
  | 'settings_changed'
  | 'diagnostic_bundle_exported'
  | 'data_deleted'
  | 'installer_completed';

export interface IAnalyticsClient {
  /** Identify the user (anon device id is fine — never email). */
  identify(deviceId: string): void;
  /** Record an event. Properties must not contain PII or transcript text. */
  track(event: AnalyticsEvent, properties?: Record<string, unknown>): void;
  /** Flush queued events. Call before app quit. */
  flush(): Promise<void>;
}

export interface AnalyticsClientDeps {
  readonly apiKey: string | null;
  /** App version for the `version` super-property. */
  readonly version: string;
  readonly logger?: Logger;
}

/** Build an Amplitude-backed client, or a debug-logging no-op if no key. */
export function buildAnalyticsClient(deps: AnalyticsClientDeps): IAnalyticsClient {
  const log = deps.logger ?? noopLogger;
  if (!deps.apiKey) {
    return {
      identify: (id) => log.debug('analytics.identify (noop)', { id }),
      track: (event, props) => log.debug('analytics.track (noop)', { event, props }),
      flush: async () => {},
    };
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const amp = require('@amplitude/analytics-node') as {
      init: (apiKey: string, opts?: unknown) => { promise: Promise<unknown> };
      identify: (id: unknown, options?: { user_id?: string }) => void;
      track: (event: string, props?: Record<string, unknown>, opts?: { user_id?: string }) => void;
      flush: () => { promise: Promise<unknown> };
      Identify: new () => unknown;
    };
    amp.init(deps.apiKey);
    let userId: string | undefined;
    return {
      identify(id) {
        userId = id;
      },
      track(event, props) {
        amp.track(event, { ...props, version: deps.version }, userId ? { user_id: userId } : undefined);
      },
      async flush() {
        await amp.flush().promise;
      },
    };
  } catch (err) {
    log.warn('@amplitude/analytics-node unavailable', {
      err: err instanceof Error ? err.message : String(err),
    });
    return {
      identify: () => {},
      track: () => {},
      flush: async () => {},
    };
  }
}
