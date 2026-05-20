/**
 * Preload — exposes the typed `electronAPI` surface to the renderer.
 *
 * Architecture: §4 (narrow IPC), §12.7 (`contextIsolation: true`, `sandbox: true`).
 *
 * This file runs in the preload context. It imports from `electron`, which is
 * intentionally not done elsewhere in `src/`. The renderer never sees
 * `ipcRenderer` — only the small `electronAPI` object exposed below.
 *
 * Typings: the API shape is defined in `types/electron-api.d.ts` (re-exported
 * for renderer code via `window.electronAPI`). Everything here is invoke or
 * subscribe; no synchronous calls.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { PUSH, REQUEST } from './channels';
import type {
  PushPayloads,
  RequestPayloads,
  PushChannel,
} from './channels';

/** Internal helper: typed wrapper around ipcRenderer.invoke for one channel. */
function invoke<C extends keyof RequestPayloads>(
  channel: C,
  input: RequestPayloads[C]['input'],
): Promise<RequestPayloads[C]['output']> {
  return ipcRenderer.invoke(channel, input) as Promise<RequestPayloads[C]['output']>;
}

/**
 * Subscribe to a push channel; returns an unsubscribe callback. We wrap the
 * raw `ipcRenderer.on` listener so the renderer never receives the IpcEvent
 * object — only the payload.
 */
function subscribe<C extends PushChannel & keyof PushPayloads>(
  channel: C,
  cb: (payload: PushPayloads[C]) => void,
): () => void {
  const listener = (_event: unknown, payload: unknown) =>
    cb(payload as PushPayloads[C]);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

/** The full surface exposed to the renderer as `window.electronAPI`. */
const electronAPI = {
  recording: {
    startDictation: () => invoke(REQUEST.REC_START_DICTATION, {}),
    stopDictation: () => invoke(REQUEST.REC_STOP_DICTATION, {}),
    startMeeting: (input: { title?: string } = {}) =>
      invoke(REQUEST.REC_START_MEETING, input),
    stopMeeting: (input: { sessionId: string }) =>
      invoke(REQUEST.REC_STOP_MEETING, input),
  },
  permissions: {
    requestMic: () => invoke(REQUEST.PERMISSIONS_REQUEST_MIC, {}),
    requestAudioCapture: () => invoke(REQUEST.PERMISSIONS_REQUEST_AUDIO_CAP, {}),
    requestAccessibility: () => invoke(REQUEST.PERMISSIONS_REQUEST_ACCESSIBILITY, {}),
    requestNotifications: () => invoke(REQUEST.PERMISSIONS_REQUEST_NOTIFICATIONS, {}),
    read: (
      input: RequestPayloads[typeof REQUEST.PERMISSIONS_READ]['input'],
    ) => invoke(REQUEST.PERMISSIONS_READ, input),
    openSystemSettings: (
      input: RequestPayloads[typeof REQUEST.PERMISSIONS_OPEN_SYSTEM_SETTINGS]['input'],
    ) => invoke(REQUEST.PERMISSIONS_OPEN_SYSTEM_SETTINGS, input),
  },
  settings: {
    get: () => invoke(REQUEST.SETTINGS_GET, {}),
    set: (settings: RequestPayloads[typeof REQUEST.SETTINGS_SET]['input']) =>
      invoke(REQUEST.SETTINGS_SET, settings),
  },
  sessions: {
    list: (input: { limit?: number } = {}) => invoke(REQUEST.SESSION_LIST, input),
    get: (input: { sessionId: string }) => invoke(REQUEST.SESSION_GET, input),
    delete: (input: { sessionId: string }) => invoke(REQUEST.SESSION_DELETE, input),
    retryFailed: (input: { sessionId: string }) =>
      invoke(REQUEST.SESSION_RETRY_FAILED, input),
    updateTitle: (input: { sessionId: string; title: string | null }) =>
      invoke(REQUEST.SESSION_UPDATE_TITLE, input),
    retrySummary: (input: { sessionId: string }) =>
      invoke(REQUEST.SESSION_RETRY_SUMMARY, input),
    openSummary: (input: { sessionId: string }) =>
      invoke(REQUEST.SESSION_OPEN_SUMMARY, input),
  },
  dictations: {
    list: (input: { limit?: number } = {}) => invoke(REQUEST.DICTATION_LIST, input),
  },
  diagnostic: {
    exportBundle: () => invoke(REQUEST.DIAGNOSTIC_EXPORT_BUNDLE, {}),
    meetingDetectionStatus: () => invoke(REQUEST.DIAGNOSTIC_MEETING_DETECTION_STATUS, {}),
  },
  data: {
    deleteEverything: () => invoke(REQUEST.DATA_DELETE_EVERYTHING, {}),
  },
  hud: {
    beginDrag: () => invoke(REQUEST.HUD_BEGIN_DRAG, {}),
    dragMoveBy: (input: RequestPayloads[typeof REQUEST.HUD_DRAG_MOVE_BY]['input']) =>
      invoke(REQUEST.HUD_DRAG_MOVE_BY, input),
    endDrag: () => invoke(REQUEST.HUD_END_DRAG, {}),
    setMouseIgnore: (input: RequestPayloads[typeof REQUEST.HUD_SET_MOUSE_IGNORE]['input']) =>
      invoke(REQUEST.HUD_SET_MOUSE_IGNORE, input),
  },
  main: {
    showSessionsTab: () => invoke(REQUEST.MAIN_SHOW_SESSIONS_TAB, {}),
    showHome: () => invoke(REQUEST.MAIN_SHOW_HOME, {}),
  },
  hotkey: {
    captureBegin: () => invoke(REQUEST.HOTKEY_CAPTURE_BEGIN, {}),
    captureEnd: () => invoke(REQUEST.HOTKEY_CAPTURE_END, {}),
  },
  recording_devices: {
    list: () => invoke(REQUEST.RECORDING_LIST_INPUT_DEVICES, {}),
    resumeFromDeviceLoss: (input: RequestPayloads[typeof REQUEST.REC_RESUME_FROM_DEVICE_LOSS]['input']) =>
      invoke(REQUEST.REC_RESUME_FROM_DEVICE_LOSS, input),
  },
  auth: {
    getState: () => invoke(REQUEST.AUTH_GET_STATE, {}),
    signIn: () => invoke(REQUEST.AUTH_SIGN_IN, {}),
    signOut: () => invoke(REQUEST.AUTH_SIGN_OUT, {}),
    listUsers: () => invoke(REQUEST.AUTH_LIST_USERS, {}),
    cancelSignIn: () => invoke(REQUEST.AUTH_CANCEL_SIGN_IN, {}),
  },
  storage: {
    importLegacy: () => invoke(REQUEST.STORAGE_IMPORT_LEGACY, {}),
  },
  wizard: {
    getStatus: () => invoke(REQUEST.WIZARD_GET_STATUS, {}),
    complete: () => invoke(REQUEST.WIZARD_COMPLETE, {}),
  },
  on: {
    recordingStateChanged: (cb: (e: PushPayloads[typeof PUSH.RECORDING_STATE]) => void) =>
      subscribe(PUSH.RECORDING_STATE, cb),
    transcriptSegmentAppended: (
      cb: (e: PushPayloads[typeof PUSH.TRANSCRIPT_SEGMENT]) => void,
    ) => subscribe(PUSH.TRANSCRIPT_SEGMENT, cb),
    queueStatusChanged: (cb: (e: PushPayloads[typeof PUSH.QUEUE_STATUS]) => void) =>
      subscribe(PUSH.QUEUE_STATUS, cb),
    permissionStateChanged: (
      cb: (e: PushPayloads[typeof PUSH.PERMISSION_STATE]) => void,
    ) => subscribe(PUSH.PERMISSION_STATE, cb),
    micActivityEvent: (cb: (e: PushPayloads[typeof PUSH.MIC_ACTIVITY]) => void) =>
      subscribe(PUSH.MIC_ACTIVITY, cb),
    meetingDetected: (cb: (e: PushPayloads[typeof PUSH.MEETING_DETECTED]) => void) =>
      subscribe(PUSH.MEETING_DETECTED, cb),
    amplitudeSample: (cb: (e: PushPayloads[typeof PUSH.AMPLITUDE_SAMPLE]) => void) =>
      subscribe(PUSH.AMPLITUDE_SAMPLE, cb),
    transcriptionUiState: (
      cb: (e: PushPayloads[typeof PUSH.TRANSCRIPTION_UI_STATE]) => void,
    ) => subscribe(PUSH.TRANSCRIPTION_UI_STATE, cb),
    navigateTab: (cb: (e: PushPayloads[typeof PUSH.NAVIGATE_TAB]) => void) =>
      subscribe(PUSH.NAVIGATE_TAB, cb),
    hotkeyChanged: (cb: (e: PushPayloads[typeof PUSH.HOTKEY_CHANGED]) => void) =>
      subscribe(PUSH.HOTKEY_CHANGED, cb),
    hotkeyCaptureKey: (cb: (e: PushPayloads[typeof PUSH.HOTKEY_CAPTURE_KEY]) => void) =>
      subscribe(PUSH.HOTKEY_CAPTURE_KEY, cb),
    micDeviceLost: (cb: (e: PushPayloads[typeof PUSH.MIC_DEVICE_LOST]) => void) =>
      subscribe(PUSH.MIC_DEVICE_LOST, cb),
    authStateChanged: (cb: (e: PushPayloads[typeof PUSH.AUTH_STATE_CHANGED]) => void) =>
      subscribe(PUSH.AUTH_STATE_CHANGED, cb),
    summaryStateChanged: (cb: (e: PushPayloads[typeof PUSH.SUMMARY_STATE_CHANGED]) => void) =>
      subscribe(PUSH.SUMMARY_STATE_CHANGED, cb),
  },
} as const;

export type ElectronAPI = typeof electronAPI;

// Expose only when contextBridge is available. In tests/storybook this file
// can be imported without crashing.
if (typeof contextBridge !== 'undefined') {
  contextBridge.exposeInMainWorld('electronAPI', electronAPI);
}
