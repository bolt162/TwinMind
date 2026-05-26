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
  MIC_DEVICE_LOST: 'mic_device_lost',
  AUTH_STATE_CHANGED: 'auth_state_changed',
  SUMMARY_STATE_CHANGED: 'summary_state_changed',
  HUD_EDGE_ANCHOR: 'hud_edge_anchor',
  /**
   * Sent by main when the user tried to start a recording (dictation or
   * meeting, from any entry point — UI button, hotkey, meeting auto-detect,
   * device-loss resume) and the macOS microphone permission is NOT
   * `granted`. The HUD renders a banner asking the user to grant the
   * permission; the orchestrator was never invoked. `not_determined` is
   * treated the same as `denied` here — we surface the banner instead of
   * silently firing the native prompt under the user.
   */
  MIC_PERMISSION_REQUIRED: 'mic_permission_required',
  /**
   * Sent from main when the macOS Accessibility grant changes for the app
   * mid-session (revoked or re-granted). Payload `granted: false` tells the
   * HUD to show a "Re-grant Accessibility" banner; `granted: true` tells it
   * to dismiss. The accessibility-revoked path also internally stops the
   * Globe-key tap + uiohook to head off the system-freeze bug that an
   * untrusted CGEventTap can trigger.
   */
  ACCESSIBILITY_LOST: 'accessibility_lost',
  /**
   * Fired when main has written dictation text to the clipboard but could
   * NOT synthesize the Cmd-V keystroke (Accessibility denied or native
   * paste returned false). HUD transitions the idle pill briefly into a
   * "Copied to clipboard" toast so the user knows the text is on the
   * clipboard and they should paste manually. Empty payload — the HUD
   * already owns the message + timing.
   */
  HUD_CLIPBOARD_TOAST: 'hud_clipboard_toast',
  /**
   * App-update state machine, broadcast by UpdateService. One push per
   * transition (idle/checking/available/downloading/ready/error). The
   * renderer mirrors this into Settings → Updates and (for `ready`) the
   * Home page banner.
   */
  UPDATE_STATE_CHANGED: 'update_state_changed',
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
  /**
   * Opens the TwinMind web app in the user's default browser. URL is
   * resolved in main from `twinmindBackendConfig.appUrl` (defaults to
   * `https://app.twinmind.com`; overridable via `TWINMIND_APP_URL` env
   * for dev/staging). Renderer can't supply a URL — keeps the open-
   * external surface narrow.
   */
  MAIN_OPEN_WEB_APP: 'main.openWebApp',
  DIAGNOSTIC_MEETING_DETECTION_STATUS: 'diagnostic.meetingDetectionStatus',
  HOTKEY_CAPTURE_BEGIN: 'hotkey.captureBegin',
  HOTKEY_CAPTURE_END: 'hotkey.captureEnd',
  RECORDING_LIST_INPUT_DEVICES: 'recording.listInputDevices',
  HUD_SET_MOUSE_IGNORE: 'hud.setMouseIgnore',
  HUD_SET_VISUAL_STATE: 'hud.setVisualState',
  REC_RESUME_FROM_DEVICE_LOSS: 'recording.resumeFromDeviceLoss',
  AUTH_GET_STATE: 'auth.getState',
  AUTH_SIGN_IN: 'auth.signIn',
  AUTH_SIGN_OUT: 'auth.signOut',
  AUTH_LIST_USERS: 'auth.listUsers',
  AUTH_CANCEL_SIGN_IN: 'auth.cancelSignIn',
  STORAGE_IMPORT_LEGACY: 'storage.importLegacy',
  WIZARD_GET_STATUS: 'wizard.getStatus',
  WIZARD_COMPLETE: 'wizard.complete',
  SESSION_RETRY_SUMMARY: 'session.retrySummary',
  SESSION_OPEN_SUMMARY: 'session.openSummary',
  REC_DICTATION_LIMIT_DISMISS: 'recording.dictationLimitDismiss',
  /** Read the current update-state snapshot (for renderer initial mount). */
  UPDATE_GET_STATE: 'update.getState',
  /** Manual "Check for updates" trigger from Settings. */
  UPDATE_CHECK_NOW: 'update.checkNow',
  /** Restart-and-install. Refuses with `recording_active` if a session is live. */
  UPDATE_QUIT_AND_INSTALL: 'update.quitAndInstall',
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
  /**
   * Cumulative audio-clock since session start, in ms. The HUD uses this
   * as the authoritative elapsed timer — drops to "stuck" when capture
   * stalls (Bluetooth profile switch, device unplug). Strictly monotonic.
   */
  readonly audioClockMs: number;
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
  | { readonly kind: 'failed'; readonly sessionId: string }
  /**
   * dictation_limit_reached → the 5-min dictation hard cap fired and the
   * orchestrator stopped the session. HUD shows a banner with Dismiss +
   * Dictate buttons. Higher visual priority than `processing` so the user
   * sees the prompt immediately (old session's chunks continue
   * transcribing in the background and paste on completion). Cleared by
   * REC_DICTATION_LIMIT_DISMISS (the Dismiss + Dictate buttons both
   * dispatch it).
   */
  | { readonly kind: 'dictation_limit_reached'; readonly sessionId: string };

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

/**
 * Fired when the user's pinned input device disappears mid-recording. The
 * orchestrator transitions to a paused state, audio-process tears down its
 * AudioUnit, and main pushes this event to the HUD so the floating button
 * can render its "Mic disconnected" affordance — an inline device picker
 * plus a Resume button.
 *
 * `devices` is the snapshot the picker should render. `lastDeviceLabel` is
 * the human-readable name of the device that just went away (best effort —
 * native may not have one if the device disappeared too quickly to read).
 */
export interface MicDeviceLost {
  readonly sessionId: string;
  readonly mode: 'dictation' | 'meeting';
  readonly lastDeviceLabel: string | null;
  readonly reason: string;
  readonly devices: ReadonlyArray<InputDeviceInfo>;
}

/**
 * Sent from main when a recording-start attempt was rejected because the
 * macOS microphone permission isn't `granted`. HUD renders a banner with
 * a context-sensitive primary action + Dismiss; the orchestrator was never
 * started.
 *
 * `mode` is the user-requested mode so future copy could vary.
 *
 * `grant` is the current TCC state, which the HUD uses to pick the right
 * primary action:
 *   - `not_determined` → "Allow" → fires the OS request dialog
 *     (askForMediaAccess). macOS only adds TwinMind to Privacy →
 *     Microphone AFTER its first askForMediaAccess call, so deep-linking
 *     to the panel from this state lands on a list that doesn't contain
 *     us — useless. We MUST fire the request from this state.
 *   - `denied` / `unavailable` → "Open settings" → deep-links to Privacy
 *     → Microphone, where TwinMind is registered with the toggle off.
 */
export interface MicPermissionRequired {
  readonly mode: 'dictation' | 'meeting';
  readonly grant: 'denied' | 'not_determined' | 'unavailable';
}

/**
 * Sent when macOS Accessibility trust for the app transitions. `granted:
 * false` means the user (or the OS) flipped the toggle off — Fn dictation
 * and configurable hotkeys are now disabled, paste falls back to clipboard
 * only. `granted: true` means trust was restored without an app restart;
 * the HUD banner clears and Fn / hotkeys come back on their own.
 */
export interface AccessibilityLost {
  readonly granted: boolean;
}

/**
 * UpdateService state machine — what the renderer needs to render Settings →
 * Updates and the Home banner.
 *
 *   idle        — no check has run yet this session, or no update found
 *   checking    — `autoUpdater.checkForUpdates()` is in flight
 *   available   — newer version exists; download started automatically
 *   downloading — bytes are flowing; `progressPercent` is 0..100
 *   ready       — download complete, SHA verified; user can "Restart & Update"
 *   error       — last check or download failed; will retry on next cycle
 *
 * `version` is the remote version when available/downloading/ready, null
 * otherwise. `error.code` is a coarse classification; `error.message` is
 * for logs / Settings page (NEVER shown to end users verbatim).
 *
 * `disabled` is true for dev/unpackaged runs and unsupported platforms —
 * Settings → Updates greys out the manual button and shows an explanatory
 * line so it's obvious nothing will happen.
 */
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error';

export interface UpdateStateChanged {
  readonly phase: UpdatePhase;
  /** Semver of the remote release when one is on offer. Null otherwise. */
  readonly version: string | null;
  /** 0..100. Defined only while `phase === 'downloading'`. */
  readonly progressPercent: number | null;
  /** Coarse error category; populated only while `phase === 'error'`. */
  readonly error: {
    readonly code: 'network' | 'integrity' | 'signature' | 'unknown';
    readonly message: string;
  } | null;
  /** App is unpackaged, wrong platform, or no publish URL — checks are noop. */
  readonly disabled: boolean;
  /** Currently running app version. Echoed for Settings header. */
  readonly currentVersion: string;
}

/**
 * Renderer-facing view of the auth state. Pushed on every transition so the
 * UI (SignInScreen / AccountCard / HUD visibility) can react.
 *
 * `user` is non-null iff `isAuthenticated`. When false, `configMissing` may
 * list the env-var names that prevented the auth provider from starting —
 * the Settings page surfaces this so deployment misconfig isn't invisible.
 */
export interface AuthUserView {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly photoUrl: string | null;
}

export interface AuthStateChanged {
  readonly isAuthenticated: boolean;
  readonly user: AuthUserView | null;
  /** Null when config is fine. Array of missing env-var names when not. */
  readonly configMissing: ReadonlyArray<string> | null;
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

/** Lifecycle of the per-meeting summary call (DB column projection). */
export type SummaryStatus = 'pending' | 'completed' | 'failed';

export interface SessionListItem {
  readonly id: string;
  readonly mode: 'dictation' | 'meeting';
  readonly status: 'active' | 'ended' | 'paused_by_sleep' | 'paused_by_device_loss';
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly title: string | null;
  /** Number of retryable `failed_permanent` chunks; drives the row's Retry button. */
  readonly failedCount: number;
  /**
   * Captured-audio duration in ms (max(chunks.end_ms) for the session). The UI
   * shows this as "recording duration" instead of (endedAt − startedAt), so a
   * device-loss pause gap doesn't inflate the displayed duration past the
   * actually-recorded audio. Null if the session has no chunks yet.
   */
  readonly audioDurationMs: number | null;
  /** Summary state for meeting sessions; null for dictation / not attempted. */
  readonly summaryStatus: SummaryStatus | null;
  /** Backend-assigned summary id; null until `summaryStatus === 'completed'`. */
  readonly summaryId: string | null;
  /**
   * True if the session has at least one transcript row with non-empty text.
   * Drives Copy / Generate-summary enabled state on the list rows without
   * needing to fetch every session's transcripts up front.
   */
  readonly hasText: boolean;
}

/** Pushed whenever a session's summary state transitions. */
export interface SummaryStateChanged {
  readonly sessionId: string;
  readonly status: SummaryStatus;
  /** Populated on `'completed'`; absent otherwise. */
  readonly summaryId?: string;
  /**
   * New session title — populated on `'completed'` if the backend
   * returned one AND main applied it (i.e., the session's title was
   * NULL). The renderer's session detail view refreshes its EditableTitle
   * from this so user-edited titles are never overwritten.
   */
  readonly title?: string;
}

export interface SessionRetrySummaryInput {
  readonly sessionId: string;
}

export interface SessionOpenSummaryInput {
  readonly sessionId: string;
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
    /** Raw chunk start, including any 2 s overlap-prefix (file-time, not new-content-time). */
    readonly startMs: number;
    readonly endMs: number;
    /** Length of the 2 s overlap prepended at the start of this chunk; 0 for chunk 0 / dictation. */
    readonly overlapPrefixMs: number;
    readonly text: string;
    /**
     * Wall-clock epoch ms captured on the desktop right before /choose was
     * called for this chunk. Meeting transcript view renders this as
     * `HH:MM`. NULL for pre-migration rows + VAD-skipped chunks; renderer
     * falls back to relative `MM:SS – MM:SS` in that case.
     */
    readonly clockTimeMs: number | null;
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
 * notification (e.g., monitor never loaded, same_meeting de-dup active,
 * own capture already running, etc.).
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
  /** Transport class from kAudioDevicePropertyTransportType. UI groups the
   *  picker into "Built-in" (kind=built_in) and "Other devices" (rest). */
  readonly kind: 'built_in' | 'bluetooth' | 'usb' | 'other';
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

/**
 * Pill visual state — the renderer pushes this to main on every transition
 * so main can decide whether to shift the HUD window to keep the expanded
 * visible bounds inside workArea. Matches the renderer's PillVisual type.
 * The state→bounds table lives in main (FloatingHudWindow).
 */
export type HudPillVisual =
  | 'idle'
  | 'hoverIdle'
  | 'busy'
  | 'recording'
  | 'processing'
  | 'failed'
  | 'dictationLimit'
  | 'disconnected'
  | 'micPermission'
  | 'accessibilityRequired'
  | 'copiedToast';

export interface HudSetVisualStateInput {
  readonly visual: HudPillVisual;
}

/**
 * Pushed by main whenever the HUD's idle pill is near an edge of the
 * current display's workArea. Renderer uses this to flip the hover-group
 * expansion direction (e.g., when pill is hugging the right edge, the
 * Take-notes / Home buttons should appear LEFT of the pill instead of
 * right, so they don't render past the screen edge).
 *
 * Both axes are emitted together so the renderer doesn't need to track
 * partial state across pushes.
 */
export interface HudEdgeAnchor {
  readonly x: 'left' | 'right' | 'center';
  readonly y: 'top' | 'bottom' | 'center';
}

/**
 * Snapshot of auth state returned by AUTH_GET_STATE. Same shape as the
 * AUTH_STATE_CHANGED push — the renderer calls this once on mount to seed
 * before subscribing, then relies on pushes for further updates.
 */
export type AuthGetStateOutput = AuthStateChanged;

/**
 * Result of AUTH_SIGN_IN. On success the renderer also receives an
 * AUTH_STATE_CHANGED push; this return value is for displaying immediate
 * feedback (e.g., "the OAuth window closed before consent").
 */
export interface AuthSignInOutput {
  /** True iff the user is now signed in. False on user-cancel or backend error. */
  readonly ok: boolean;
  /** Short, user-safe error label when `ok === false`. */
  readonly error?: 'cancelled' | 'config_missing' | 'network' | 'unknown';
  /** Human-readable detail; never includes tokens. */
  readonly message?: string;
}

/**
 * Result of AUTH_SIGN_OUT. Most attempts succeed (`{ ok: true }`); the only
 * non-success case today is when a recording is in flight — main refuses to
 * sign the user out while audio is being captured because that would
 * orphan the in-progress chunks. The renderer shows a "stop the recording
 * first" modal in that case.
 */
export interface AuthSignOutOutput {
  readonly ok: boolean;
  readonly error?: 'recording_active';
}

/**
 * One row from the local user directory. NEVER includes the refresh token —
 * the renderer only needs identity for the welcome screen's "Continue as X"
 * affordance.
 */
export interface AuthUserDirectoryEntry {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly photoUrl: string | null;
  readonly lastSignedInAt: number;
  /** True iff a refresh token is still stored for this user (auto-resume possible). */
  readonly hasRefreshToken: boolean;
}

export interface AuthListUsersOutput {
  readonly users: ReadonlyArray<AuthUserDirectoryEntry>;
}

export interface StorageImportLegacyOutput {
  /** True iff legacy data was found and moved into the active user. */
  readonly imported: boolean;
  /** Number of sessions moved (0 when nothing to import). */
  readonly sessionsImported: number;
}

/** Machine-scoped wizard status — read from GlobalDb.wizard. */
export interface WizardGetStatusOutput {
  /** Epoch ms when the wizard was first finished on this machine, or null. */
  readonly onboardingCompletedAt: number | null;
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
  [PUSH.MIC_DEVICE_LOST]: MicDeviceLost;
  [PUSH.AUTH_STATE_CHANGED]: AuthStateChanged;
  [PUSH.SUMMARY_STATE_CHANGED]: SummaryStateChanged;
  [PUSH.HUD_EDGE_ANCHOR]: HudEdgeAnchor;
  [PUSH.MIC_PERMISSION_REQUIRED]: MicPermissionRequired;
  [PUSH.ACCESSIBILITY_LOST]: AccessibilityLost;
  [PUSH.HUD_CLIPBOARD_TOAST]: Empty;
  [PUSH.UPDATE_STATE_CHANGED]: UpdateStateChanged;
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
        readonly status: 'active' | 'ended' | 'paused_by_sleep' | 'paused_by_device_loss';
        readonly startedAt: number;
        readonly endedAt: number | null;
        readonly failedCount: number;
        readonly audioDurationMs: number | null;
        readonly transcripts: ReadonlyArray<{
          readonly chunkId: string;
          readonly startMs: number;
          readonly endMs: number;
          readonly overlapPrefixMs: number;
          readonly text: string;
          readonly clockTimeMs: number | null;
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
  [REQUEST.MAIN_OPEN_WEB_APP]: { input: Empty; output: Empty };
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
  [REQUEST.HUD_SET_VISUAL_STATE]: { input: HudSetVisualStateInput; output: Empty };
  [REQUEST.REC_RESUME_FROM_DEVICE_LOSS]: {
    input: { readonly sessionId: string; readonly deviceId: string | null };
    output: Empty;
  };
  [REQUEST.AUTH_GET_STATE]: { input: Empty; output: AuthGetStateOutput };
  [REQUEST.AUTH_SIGN_IN]: { input: Empty; output: AuthSignInOutput };
  [REQUEST.AUTH_SIGN_OUT]: { input: Empty; output: AuthSignOutOutput };
  [REQUEST.AUTH_LIST_USERS]: { input: Empty; output: AuthListUsersOutput };
  [REQUEST.AUTH_CANCEL_SIGN_IN]: { input: Empty; output: Empty };
  [REQUEST.STORAGE_IMPORT_LEGACY]: { input: Empty; output: StorageImportLegacyOutput };
  [REQUEST.WIZARD_GET_STATUS]: { input: Empty; output: WizardGetStatusOutput };
  [REQUEST.WIZARD_COMPLETE]: { input: Empty; output: Empty };
  [REQUEST.SESSION_RETRY_SUMMARY]: { input: SessionRetrySummaryInput; output: Empty };
  [REQUEST.SESSION_OPEN_SUMMARY]: { input: SessionOpenSummaryInput; output: Empty };
  [REQUEST.REC_DICTATION_LIMIT_DISMISS]: { input: Empty; output: Empty };
  [REQUEST.UPDATE_GET_STATE]: { input: Empty; output: UpdateStateChanged };
  [REQUEST.UPDATE_CHECK_NOW]: { input: Empty; output: Empty };
  /**
   * Returns `{ ok: true }` on success (the app is about to quit) or
   * `{ ok: false, error: 'recording_active' | 'not_ready' }` when the install
   * can't proceed right now. Renderer copies its banner text from the error.
   */
  [REQUEST.UPDATE_QUIT_AND_INSTALL]: {
    input: Empty;
    output: {
      readonly ok: boolean;
      readonly error?: 'recording_active' | 'not_ready';
    };
  };
}
