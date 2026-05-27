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
  | 'app_quit'
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
  | 'meeting_notification_failed'
  | 'meeting_notification_outcome'
  | 'meeting_detection_suppressed'
  | 'settings_changed'
  | 'diagnostic_bundle_exported'
  | 'data_deleted'
  | 'installer_completed'
  | 'update_check_started'
  | 'update_available'
  | 'update_downloaded'
  | 'update_install_clicked'
  | 'update_install_blocked_by_recording'
  | 'update_error'
  /**
   * Umbrella event for failures that don't have (or don't warrant) their own
   * typed event. Properties carry a `type` string for filtering — e.g.
   * `auth_sign_in`, `summary_request`, `native_addon_load`. Tailored errors
   * (transcription_failed, update_error) keep their specific events because
   * their property shapes are richer.
   */
  | 'error_occurred';

export interface IAnalyticsClient {
  /**
   * Identify the user once they've signed in. `userId` is the raw
   * provider-prefixed id (e.g. `google-oauth2_<digits>`). Once called,
   * every subsequent track() call carries `user_id`. The device_id passed
   * to the factory keeps flowing alongside.
   */
  identify(userId: string): void;
  /** Record an event. Properties must not contain PII or transcript text. */
  track(event: AnalyticsEvent, properties?: Record<string, unknown>): void;
  /** Flush queued events. Call before app quit. */
  flush(): Promise<void>;
}

/**
 * Standard Amplitude event-level fields that describe the device the event
 * came from. Mapped 1:1 to the SDK's track-options shape and surfaced as
 * first-class columns in the Amplitude UI (Platform / OS / Brand /
 * Language). Collected once at app-launch in composition.ts and merged
 * into every event by AnalyticsClient.track.
 *
 * `country` / `region` / `city` are deliberately NOT here — Amplitude's
 * ingestion server derives those from the POST source IP automatically.
 */
export interface AnalyticsDeviceContext {
  readonly platform?: string;
  readonly os_name?: string;
  readonly os_version?: string;
  readonly device_brand?: string;
  readonly device_manufacturer?: string;
  readonly language?: string;
}

export interface AnalyticsClientDeps {
  readonly apiKey: string | null;
  /** App version for the `version` super-property. */
  readonly version: string;
  /**
   * Stable per-machine identifier — sent as `device_id` on every event.
   * @amplitude/analytics-node requires either user_id OR device_id per
   * event server-side; we always send device_id so pre-sign-in events
   * (e.g. app_launched) don't get rejected as "missing required field".
   * Sourced from GlobalDb.getOrCreateDeviceId().
   */
  readonly deviceId: string;
  /** Standard Amplitude device-context fields; sent on every event. */
  readonly deviceContext?: AnalyticsDeviceContext;
  /**
   * Free-form user properties attached to every event via Amplitude's
   * `user_properties` field. Use for static device metadata like
   * `device_type: 'Desktop'` / `device_family: 'Mac'` that doesn't fit
   * a standard Amplitude column.
   */
  readonly userProperties?: Record<string, unknown>;
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
    // Track-options keys mirror Amplitude's standard event-level fields.
    // We allow-list the ones we send; the SDK accepts more (carriers,
    // mobile-only ids, etc.) but we don't fill them on a desktop app.
    type TrackOptions = {
      user_id?: string;
      device_id?: string;
      platform?: string;
      os_name?: string;
      os_version?: string;
      device_brand?: string;
      device_manufacturer?: string;
      language?: string;
      user_properties?: Record<string, unknown>;
    };
    const amp = require('@amplitude/analytics-node') as {
      init: (apiKey: string, opts?: unknown) => { promise: Promise<unknown> };
      identify: (id: unknown, options?: TrackOptions) => void;
      track: (event: string, props?: Record<string, unknown>, opts?: TrackOptions) => void;
      flush: () => { promise: Promise<unknown> };
      Identify: new () => unknown;
    };
    amp.init(deps.apiKey);
    let userId: string | undefined;
    // Pre-compute the per-event option base so we only build it once per
    // app launch instead of merging on every track call. user_id is
    // layered on at call time since it changes with sign-in.
    const optsBase: TrackOptions = {
      device_id: deps.deviceId,
      ...(deps.deviceContext ?? {}),
      ...(deps.userProperties ? { user_properties: deps.userProperties } : {}),
    };
    return {
      identify(id) {
        userId = id;
      },
      track(event, props) {
        // device_id ALWAYS present; user_id added once identify() has been
        // called. Amplitude server-side requires at least one of these on
        // every event; this shape covers both pre-sign-in and signed-in
        // states cleanly, and lets Amplitude stitch anonymous activity
        // into the user's profile once both fields land on a single event.
        // deviceContext + userProperties ride along on every event so
        // Amplitude's UI shows platform/os/brand columns and user_props.
        amp.track(
          event,
          { ...props, version: deps.version },
          userId ? { ...optsBase, user_id: userId } : optsBase,
        );
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
