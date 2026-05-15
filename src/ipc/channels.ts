/**
 * IPC channel names + typed payload shapes.
 *
 * Architecture: §4 (IPC contract — narrow on purpose), §12.7 (every channel has
 * a Zod validator on both ends; renderer cannot pass paths to main).
 *
 * Two directions:
 *  - PUSH: main → renderer broadcasts. Channel name in `PUSH.*`.
 *  - REQUEST: renderer → main, request/reply via `ipcRenderer.invoke`. Names in `REQUEST.*`.
 *
 * Renderer code imports *types* from this file (no Zod dep in renderer bundle).
 * The schemas in `validators.ts` are imported only by `bridge.main.ts`.
 */

// ─── Channel name constants ─────────────────────────────────────────────────

export const PUSH = {
  RECORDING_STATE: 'recording_state_changed',
  TRANSCRIPT_SEGMENT: 'transcript_segment_appended',
  QUEUE_STATUS: 'queue_status_changed',
  PERMISSION_STATE: 'permission_state_changed',
  MIC_ACTIVITY: 'mic_activity_event',
  MEETING_DETECTED: 'meeting_detected',
  AMPLITUDE_SAMPLE: 'amplitude_sample',
  TRANSCRIPTION_UI_STATE: 'transcription_ui_state',
  NAVIGATE_TAB: 'navigate_tab',
  HOTKEY_CHANGED: 'hotkey_changed',
  HOTKEY_CAPTURE_KEY: 'hotkey_capture_key',
} as const;
export type PushChannel = (typeof PUSH)[keyof typeof PUSH];

export const REQUEST = {
  REC_START_DICTATION: 'recording.startDictation',
  REC_STOP_DICTATION: 'recording.stopDictation',
  REC_START_MEETING: 'recording.startMeeting',
  REC_STOP_MEETING: 'recording.stopMeeting',
  PERMISSIONS_REQUEST_MIC: 'permissions.requestMic',
  PERMISSIONS_REQUEST_AUDIO_CAP: 'permissions.requestAudioCap',
  PERMISSIONS_REQUEST_ACCESSIBILITY: 'permissions.requestAccessibility',
  PERMISSIONS_REQUEST_NOTIFICATIONS: 'permissions.requestNotifications',
  PERMISSIONS_READ: 'permissions.read',
  PERMISSIONS_OPEN_SYSTEM_SETTINGS: 'permissions.openSystemSettings',
  SETTINGS_GET: 'settings.get',
  SETTINGS_SET: 'settings.set',
  SETTINGS_SET_SECRET: 'settings.setSecret',
  SETTINGS_HAS_SECRET: 'settings.hasSecret',
  SESSION_LIST: 'session.list',
  SESSION_GET: 'session.get',
  SESSION_DELETE: 'session.delete',
  SESSION_UPDATE_TITLE: 'session.updateTitle',
  DICTATION_LIST: 'dictation.list',
  DIAGNOSTIC_EXPORT_BUNDLE: 'diagnostic.exportBundle',
  DATA_DELETE_EVERYTHING: 'data.deleteEverything',
  HUD_BEGIN_DRAG: 'hud.beginDrag',
  HUD_DRAG_MOVE_BY: 'hud.dragMoveBy',
  HUD_END_DRAG: 'hud.endDrag',
  SESSION_RETRY_FAILED: 'session.retryFailed',
  MAIN_SHOW_SESSIONS_TAB: 'main.showSessionsTab',
  MAIN_SHOW_HOME: 'main.showHome',
  DIAGNOSTIC_MEETING_DETECTION_STATUS: 'diagnostic.meetingDetectionStatus',
  HOTKEY_CAPTURE_BEGIN: 'hotkey.captureBegin',
  HOTKEY_CAPTURE_END: 'hotkey.captureEnd',
  RECORDING_LIST_INPUT_DEVICES: 'recording.listInputDevices',
  HUD_SET_MOUSE_IGNORE: 'hud.setMouseIgnore',
} as const;
export type RequestChannel = (typeof REQUEST)[keyof typeof REQUEST];

// ─── PUSH payload types ─────────────────────────────────────────────────────

export type RecordingMode = 'idle' | 'dictation' | 'meeting';
export type RecordingState =
  | 'starting'
  | 'recording'
  | 'stopping'
  | 'paused_by_sleep'
  | 'ended';

export interface RecordingStateChanged {
  readonly mode: RecordingMode;
  readonly state: RecordingState;
  readonly sessionId?: string;
  readonly elapsedMs?: number;
}

export interface TranscriptSegmentAppended {
  readonly sessionId: string;
  readonly chunkId: string;
  /** 'mic' for dictation, 'mixed' for meeting (§7.5). */
  readonly source: 'mic' | 'mixed';
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export interface QueueStatusChanged {
  readonly pending: number;
  readonly uploading: number;
  readonly failedPermanent: number;
}

export type PermissionGrant = 'granted' | 'denied' | 'not_determined' | 'unavailable';

export interface PermissionStateChanged {
  readonly mic: PermissionGrant;
  readonly audioCapture: PermissionGrant;
  readonly accessibility: PermissionGrant;
  readonly notifications: PermissionGrant;
}

export type MicActivityKind = 'detected' | 'notified' | 'dismissed' | 'accepted';

export interface MicActivityEvent {
  readonly kind: MicActivityKind;
  readonly occurredAt: number;
}

export interface MeetingDetected {
  readonly promptId: string;
  readonly suggestedTitle?: string;
}

/** Live HUD meter sample. Streamed at ~10 Hz while recording. */
export interface AmplitudeSample {
  /** Normalized RMS, 0..1. */
  readonly value: number;
}

/**
 * High-level UI state for the floating HUD's retry/failure affordances.
 * Recording state is independent and takes visual priority in the renderer.
 *
 *   idle        → HUD shows its default dot.
 *   processing  → queue is working on chunks the user cares about — either
 *                 the just-finished recording's initial uploads OR a manual
 *                 retry. HUD shows the circular loader. New recordings are
 *                 blocked until this resolves.
 *   failed      → at least one chunk for `sessionId` is in `failed_permanent`
 *                 for a retryable error class. HUD shows the expanded error
 *                 banner with Retry + History buttons; Retry retries this
 *                 specific session.
 */
export type TranscriptionUiState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'processing' }
  | { readonly kind: 'failed'; readonly sessionId: string };

export interface NavigateTab {
  readonly tab: 'recording' | 'dictations' | 'meetings' | 'settings';
}

/**
 * Broadcast whenever the user-configured primary hotkey changes. Listeners
 * (HUD chip, future onboarding hints) re-render with the new label without
 * having to poll settings. `primary` is the structured Hotkey serialized as
 * an opaque object — consumers import the type from `@core/hotkey/HotkeyTypes`.
 */
export interface HotkeyChanged {
  readonly primary: unknown;
}

/**
 * Push from main while the hotkey picker is in capture mode. macOS doesn't
 * expose Fn through `KeyboardEvent`, so we forward Fn (Globe) transitions
 * from `DarwinGlobeKeyManager` to the renderer as synthetic key events that
 * the picker treats identically to a real keydown/keyup with code='Fn'.
 *
 * Only emitted between HOTKEY_CAPTURE_BEGIN and HOTKEY_CAPTURE_END — outside
 * capture mode, the same Fn events route through the gesture recognizer.
 */
export interface HotkeyCaptureKey {
  readonly kind: 'down' | 'up';
  /** KeyboardEvent.code-style identifier. Always 'Fn' today. */
  readonly code: string;
}

// ─── REQUEST input/output types ─────────────────────────────────────────────

export type Empty = Record<string, never>;

export interface StartMeetingInput {
  readonly title?: string;
}
export interface StartMeetingOutput {
  readonly sessionId: string;
}

export interface StopMeetingInput {
  readonly sessionId: string;
}

export interface PermissionResult {
  readonly granted: boolean;
}

export type PermissionKind = 'mic' | 'audioCapture' | 'accessibility' | 'notifications';
export interface OpenSystemSettingsInput {
  readonly kind: PermissionKind;
}

/** Mirror of AppSettings in SettingsStore — but redeclared here so the renderer
 *  doesn't pull the storage module into its bundle. Keep them in sync. */
export interface SettingsPayload {
  readonly _version: number;
  // Use a deep-partial-like shape; the validator owns the strict definition.
  readonly [key: string]: unknown;
}

/**
 * Secret-write payload. The renderer never reads secrets back; only writes.
 * Main encrypts the value via DarwinSecureStorage and stores it in JobStore.kv.
 *
 * Supported names — exhaustive on purpose so a typo is a compile error.
 */
export type SecretName = 'groq_api_key';
export interface SettingsSetSecretInput {
  readonly name: SecretName;
  /** UTF-8 cleartext. Empty string CLEARS the secret. */
  readonly value: string;
}

export interface SettingsHasSecretInput {
  readonly name: SecretName;
}
export interface SettingsHasSecretOutput {
  readonly present: boolean;
}

export interface SessionListItem {
  readonly id: string;
  readonly mode: 'dictation' | 'meeting';
  readonly status: 'active' | 'ended' | 'paused_by_sleep';
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly title: string | null;
  /** Number of retryable `failed_permanent` chunks; drives the row's Retry button. */
  readonly failedCount: number;
}

export interface SessionListInput {
  readonly limit?: number;
}

export interface SessionListOutput {
  readonly sessions: ReadonlyArray<SessionListItem>;
}

export interface SessionGetInput {
  readonly sessionId: string;
}

export interface SessionGetOutput extends SessionListItem {
  readonly transcripts: ReadonlyArray<{
    readonly chunkId: string;
    readonly startMs: number;
    readonly endMs: number;
    readonly text: string;
  }>;
}

export interface SessionDeleteInput {
  readonly sessionId: string;
}

export interface SessionRetryFailedInput {
  readonly sessionId: string;
}
export interface SessionRetryFailedOutput {
  /** Number of chunks reset from `failed_permanent` back to `captured`. */
  readonly retried: number;
}

export interface DiagnosticBundleOutput {
  /** Absolute path to the staged ZIP bundle. */
  readonly path: string;
}

/**
 * Meeting-detection diagnostic snapshot. Shown in Settings → Meeting
 * auto-detection so the user can see WHY a Meet didn't trigger a
 * notification (e.g., monitor never loaded, cooldown active, etc.).
 */
export type MicActivityEventState =
  | 'started'
  | 'stopped'
  | 'notified'
  | 'dismissed'
  | 'accepted'
  | 'suppressed';

export interface MicActivityEventRow {
  readonly id: number;
  readonly occurredAt: number;
  readonly state: MicActivityEventState;
  readonly sourcePid: number | null;
  readonly sourceBundle: string | null;
  /** JSON string; for `suppressed` rows this carries `{ reason }`. */
  readonly meta: string | null;
}

/** Audio input device the user can pick from in Settings → Recording. */
export interface InputDeviceInfo {
  /** CoreAudio device UID — stored in settings.recording.inputDeviceId. */
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
}

export interface RecordingListInputDevicesOutput {
  readonly devices: ReadonlyArray<InputDeviceInfo>;
}

export interface MeetingDetectionStatusOutput {
  /** Did the native @twinmind/coreaudio-darwin addon load? */
  readonly monitorAvailable: boolean;
  /** Load error message if monitorAvailable is false. */
  readonly monitorLoadError: string | null;
  /** Did MeetingDetectionService.start() run? */
  readonly serviceStarted: boolean;
  readonly serviceStartedAt: number | null;
  /** Most-recent events, newest first. */
  readonly recentEvents: ReadonlyArray<MicActivityEventRow>;
}

/** Cumulative cursor delta in screen pixels since the matching beginDrag. */
export interface HudDragMoveByInput {
  readonly dx: number;
  readonly dy: number;
}

export interface HudSetMouseIgnoreInput {
  /**
   * True = let clicks pass through the HUD window to whatever's under it.
   * False = HUD captures clicks normally. Toggled by the renderer based on
   * whether the cursor is over an interactive element (pill, Home button).
   */
  readonly ignore: boolean;
}

// ─── Channel → payload map (compile-time directory) ─────────────────────────

/** Push events: channel name → broadcast payload type. */
export interface PushPayloads {
  [PUSH.RECORDING_STATE]: RecordingStateChanged;
  [PUSH.TRANSCRIPT_SEGMENT]: TranscriptSegmentAppended;
  [PUSH.QUEUE_STATUS]: QueueStatusChanged;
  [PUSH.PERMISSION_STATE]: PermissionStateChanged;
  [PUSH.MIC_ACTIVITY]: MicActivityEvent;
  [PUSH.MEETING_DETECTED]: MeetingDetected;
  [PUSH.AMPLITUDE_SAMPLE]: AmplitudeSample;
  [PUSH.TRANSCRIPTION_UI_STATE]: TranscriptionUiState;
  [PUSH.NAVIGATE_TAB]: NavigateTab;
  [PUSH.HOTKEY_CHANGED]: HotkeyChanged;
  [PUSH.HOTKEY_CAPTURE_KEY]: HotkeyCaptureKey;
}

/** Request channels: channel name → { input, output } pair. */
export interface RequestPayloads {
  [REQUEST.REC_START_DICTATION]: { input: Empty; output: Empty };
  [REQUEST.REC_STOP_DICTATION]: { input: Empty; output: Empty };
  [REQUEST.REC_START_MEETING]: { input: StartMeetingInput; output: StartMeetingOutput };
  [REQUEST.REC_STOP_MEETING]: { input: StopMeetingInput; output: Empty };
  [REQUEST.PERMISSIONS_REQUEST_MIC]: { input: Empty; output: PermissionResult };
  [REQUEST.PERMISSIONS_REQUEST_AUDIO_CAP]: { input: Empty; output: PermissionResult };
  [REQUEST.PERMISSIONS_REQUEST_ACCESSIBILITY]: { input: Empty; output: PermissionResult };
  [REQUEST.PERMISSIONS_REQUEST_NOTIFICATIONS]: { input: Empty; output: PermissionResult };
  [REQUEST.PERMISSIONS_READ]: {
    input: { kind: 'mic' | 'audioCapture' | 'accessibility' | 'notifications' };
    output: { grant: PermissionGrant };
  };
  [REQUEST.PERMISSIONS_OPEN_SYSTEM_SETTINGS]: { input: OpenSystemSettingsInput; output: Empty };
  [REQUEST.SETTINGS_GET]: { input: Empty; output: SettingsPayload };
  [REQUEST.SETTINGS_SET]: { input: SettingsPayload; output: Empty };
  [REQUEST.SETTINGS_SET_SECRET]: { input: SettingsSetSecretInput; output: Empty };
  [REQUEST.SETTINGS_HAS_SECRET]: { input: SettingsHasSecretInput; output: SettingsHasSecretOutput };
  [REQUEST.SESSION_LIST]: { input: SessionListInput; output: SessionListOutput };
  [REQUEST.SESSION_GET]: { input: SessionGetInput; output: SessionGetOutput };
  [REQUEST.SESSION_DELETE]: { input: SessionDeleteInput; output: Empty };
  [REQUEST.SESSION_UPDATE_TITLE]: {
    input: { sessionId: string; title: string | null };
    output: Empty;
  };
  [REQUEST.DICTATION_LIST]: {
    input: { limit?: number };
    output: {
      dictations: ReadonlyArray<{
        readonly id: string;
        readonly status: 'active' | 'ended' | 'paused_by_sleep';
        readonly startedAt: number;
        readonly endedAt: number | null;
        readonly failedCount: number;
        readonly transcripts: ReadonlyArray<{
          readonly chunkId: string;
          readonly startMs: number;
          readonly endMs: number;
          readonly text: string;
        }>;
      }>;
    };
  };
  [REQUEST.DIAGNOSTIC_EXPORT_BUNDLE]: { input: Empty; output: DiagnosticBundleOutput };
  [REQUEST.DATA_DELETE_EVERYTHING]: { input: Empty; output: Empty };
  [REQUEST.HUD_BEGIN_DRAG]: { input: Empty; output: Empty };
  [REQUEST.HUD_DRAG_MOVE_BY]: { input: HudDragMoveByInput; output: Empty };
  [REQUEST.HUD_END_DRAG]: { input: Empty; output: Empty };
  [REQUEST.SESSION_RETRY_FAILED]: {
    input: SessionRetryFailedInput;
    output: SessionRetryFailedOutput;
  };
  [REQUEST.MAIN_SHOW_SESSIONS_TAB]: { input: Empty; output: Empty };
  [REQUEST.MAIN_SHOW_HOME]: { input: Empty; output: Empty };
  [REQUEST.DIAGNOSTIC_MEETING_DETECTION_STATUS]: {
    input: Empty;
    output: MeetingDetectionStatusOutput;
  };
  [REQUEST.HOTKEY_CAPTURE_BEGIN]: { input: Empty; output: Empty };
  [REQUEST.HOTKEY_CAPTURE_END]: { input: Empty; output: Empty };
  [REQUEST.RECORDING_LIST_INPUT_DEVICES]: {
    input: Empty;
    output: RecordingListInputDevicesOutput;
  };
  [REQUEST.HUD_SET_MOUSE_IGNORE]: { input: HudSetMouseIgnoreInput; output: Empty };
}
