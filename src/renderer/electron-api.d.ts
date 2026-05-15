/**
 * Global ambient declaration for `window.electronAPI`.
 *
 * The actual surface is defined in `src/ipc/bridge.preload.ts` and exposed via
 * `contextBridge.exposeInMainWorld('electronAPI', ...)`. Renderer code reads
 * it through `window.electronAPI`; this `.d.ts` makes TypeScript happy.
 */

import type { PushPayloads, RequestPayloads } from '@ipc/channels';

declare global {
  interface Window {
    readonly electronAPI: {
      readonly recording: {
        startDictation(): Promise<Record<string, never>>;
        stopDictation(): Promise<Record<string, never>>;
        startMeeting(input?: { title?: string }): Promise<{ sessionId: string }>;
        stopMeeting(input: { sessionId: string }): Promise<Record<string, never>>;
      };
      readonly permissions: {
        requestMic(): Promise<{ granted: boolean }>;
        requestAudioCapture(): Promise<{ granted: boolean }>;
        requestAccessibility(): Promise<{ granted: boolean }>;
        requestNotifications(): Promise<{ granted: boolean }>;
        read(
          input: RequestPayloads['permissions.read']['input'],
        ): Promise<RequestPayloads['permissions.read']['output']>;
        openSystemSettings(
          input: RequestPayloads['permissions.openSystemSettings']['input'],
        ): Promise<Record<string, never>>;
      };
      readonly settings: {
        get(): Promise<RequestPayloads['settings.get']['output']>;
        set(s: RequestPayloads['settings.set']['input']): Promise<Record<string, never>>;
        setSecret(
          input: RequestPayloads['settings.setSecret']['input'],
        ): Promise<Record<string, never>>;
        hasSecret(
          input: RequestPayloads['settings.hasSecret']['input'],
        ): Promise<RequestPayloads['settings.hasSecret']['output']>;
      };
      readonly sessions: {
        list(input?: { limit?: number }): Promise<RequestPayloads['session.list']['output']>;
        get(input: { sessionId: string }): Promise<RequestPayloads['session.get']['output']>;
        delete(input: { sessionId: string }): Promise<Record<string, never>>;
        retryFailed(
          input: { sessionId: string },
        ): Promise<RequestPayloads['session.retryFailed']['output']>;
        updateTitle(input: {
          sessionId: string;
          title: string | null;
        }): Promise<Record<string, never>>;
      };
      readonly dictations: {
        list(input?: { limit?: number }): Promise<RequestPayloads['dictation.list']['output']>;
      };
      readonly diagnostic: {
        exportBundle(): Promise<{ path: string }>;
        meetingDetectionStatus(): Promise<
          RequestPayloads['diagnostic.meetingDetectionStatus']['output']
        >;
      };
      readonly data: {
        deleteEverything(): Promise<Record<string, never>>;
      };
      readonly hud: {
        beginDrag(): Promise<Record<string, never>>;
        dragMoveBy(
          input: RequestPayloads['hud.dragMoveBy']['input'],
        ): Promise<Record<string, never>>;
        endDrag(): Promise<Record<string, never>>;
        setMouseIgnore(
          input: RequestPayloads['hud.setMouseIgnore']['input'],
        ): Promise<Record<string, never>>;
      };
      readonly main: {
        showSessionsTab(): Promise<Record<string, never>>;
        showHome(): Promise<Record<string, never>>;
      };
      readonly hotkey: {
        captureBegin(): Promise<Record<string, never>>;
        captureEnd(): Promise<Record<string, never>>;
      };
      readonly recording_devices: {
        list(): Promise<RequestPayloads['recording.listInputDevices']['output']>;
      };
      readonly on: {
        recordingStateChanged(
          cb: (e: PushPayloads['recording_state_changed']) => void,
        ): () => void;
        transcriptSegmentAppended(
          cb: (e: PushPayloads['transcript_segment_appended']) => void,
        ): () => void;
        queueStatusChanged(
          cb: (e: PushPayloads['queue_status_changed']) => void,
        ): () => void;
        permissionStateChanged(
          cb: (e: PushPayloads['permission_state_changed']) => void,
        ): () => void;
        micActivityEvent(
          cb: (e: PushPayloads['mic_activity_event']) => void,
        ): () => void;
        meetingDetected(
          cb: (e: PushPayloads['meeting_detected']) => void,
        ): () => void;
        amplitudeSample(
          cb: (e: PushPayloads['amplitude_sample']) => void,
        ): () => void;
        transcriptionUiState(
          cb: (e: PushPayloads['transcription_ui_state']) => void,
        ): () => void;
        navigateTab(
          cb: (e: PushPayloads['navigate_tab']) => void,
        ): () => void;
        hotkeyChanged(
          cb: (e: PushPayloads['hotkey_changed']) => void,
        ): () => void;
        hotkeyCaptureKey(
          cb: (e: PushPayloads['hotkey_capture_key']) => void,
        ): () => void;
      };
    };
  }
}

export {};
