/**
 * main.ts — Electron entry point.
 *
 * Architecture: §4 (three processes), §5 (composition wires services from
 * interfaces), §7.10 (power events), §8 (meeting auto-detect), §16.1
 * (onboarding gate before recording).
 *
 * Responsibilities (in order):
 *   1. `app.whenReady` → spawn the `audio-process` utility process.
 *   2. Build the platform services bundle (Darwin impls of every OS interface).
 *   3. Call composition root with the audio link + platform services.
 *   4. Wire IPC handlers via `IpcBridgeMain`.
 *   5. Create the main BrowserWindow + Wispr-style floating HUD overlay.
 *   6. Wire orchestrator + power monitor + meeting-detect + hotkey + paste.
 *   7. Broadcast orchestrator state changes to all windows.
 *   8. On quit, tear everything down in reverse order.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  ipcMain,
  MessageChannelMain,
  powerMonitor,
  utilityProcess,
  type MessagePortMain,
  type UtilityProcess,
  type WebContents,
} from 'electron';

import { compose, type ComposedApp, type PlatformServices } from './composition';
import { IpcBridgeMain } from '@ipc/bridge.main';
import { PUSH, REQUEST, type SettingsPayload } from '@ipc/channels';
import type { AppSettings } from '@core/storage/SettingsStore';
import type { AudioProcessLink } from '@core/audio/AudioProcessLink';
import type { AudioToMain, MainToAudio } from '@audio-process/protocol';
import { FloatingHudWindow } from './main/FloatingHudWindow';
import { TranscriptionUx } from './main/TranscriptionUx';
import { TrayManager } from './main/Tray';
import { PowerMonitorAdapter } from '@core/audio/PowerMonitorAdapter';
import { HotkeyGestureRecognizer } from '@core/hotkey/HotkeyGestureRecognizer';
import { DarwinSecureStorage } from '@platform/darwin/DarwinSecureStorage';
import { DarwinPermissionService } from '@platform/darwin/DarwinPermissionService';
import { DarwinPasteService } from '@platform/darwin/DarwinPasteService';
import { DarwinNotificationService } from '@platform/darwin/DarwinNotificationService';
import { DarwinHotkeyManager } from '@platform/darwin/DarwinHotkeyManager';
import { DarwinGlobeKeyManager } from '@platform/darwin/DarwinGlobeKeyManager';
import { DarwinDeviceMonitor } from '@platform/darwin/DarwinDeviceMonitor';
import type { IMicActivityMonitor } from '@platform/IMicActivityMonitor';
import type { IGlobeKeyManager } from '@platform/IGlobeKeyManager';
import { hotkeysEqual, type Hotkey } from '@core/hotkey/HotkeyTypes';
import { resolveAudioteeBinaryPath } from '@platform/audioteeBinaryPath';

// Isolate V2 userData from any V1 install. macOS is case-insensitive on the
// default APFS volume, so the V1 productName "TwinMind" and V2's would resolve
// to the same `~/Library/Application Support/twinmind/` directory — V2 would
// inherit V1's settings (onboardingCompletedAt set, stale hotkey binding) and
// skip onboarding on a fresh install. Pinning userData to a V2-specific path
// keeps the two installs fully separate without changing the visible app name.
// Must run before any code reads app.getPath('userData').
app.setPath('userData', path.join(app.getPath('appData'), 'TwinMind-V2'));

let composed: ComposedApp | null = null;
let mainWindow: BrowserWindow | null = null;
let hud: FloatingHudWindow | null = null;
/**
 * True once `settings.onboardingCompletedAt` is non-null. Gates the HUD
 * visibility and all hotkey-triggered recording actions so neither fires
 * during the onboarding wizard. Flips inside the SETTINGS_SET handler the
 * moment the user finishes onboarding (no restart required).
 */
let onboardingComplete = false;
let audioProcessHandle: UtilityProcess | null = null;
let audioPort: MessagePortMain | null = null;
let bridge: IpcBridgeMain | null = null;
let transcriptionUx: TranscriptionUx | null = null;
let tray: TrayManager | null = null;
/**
 * Currently-applied primary hotkey + its unregister callback. Lets the
 * SETTINGS_SET handler hot-swap the binding when the user captures a new
 * hotkey, without restarting the app.
 */
let primaryHotkey: Hotkey | null = null;
let primaryHotkeyUnregister: (() => void) | null = null;
/**
 * Set by the HOTKEY_CAPTURE_BEGIN IPC. While non-null, the Globe (Fn) handler
 * forwards Fn down/up events to this WebContents as HOTKEY_CAPTURE_KEY
 * pushes *instead of* running them through the gesture recognizer. Lets the
 * picker capture Fn the same way it captures every other modifier.
 *
 * Cleared by HOTKEY_CAPTURE_END or when the WebContents is destroyed.
 */
let hotkeyCaptureWebContents: WebContents | null = null;
/**
 * Diagnostic status for meeting-detection. Surfaced via the
 * DIAGNOSTIC_MEETING_DETECTION_STATUS IPC so the user can see — in the
 * Settings panel — whether the native mic-activity addon loaded at all.
 * If `monitorAvailable === false`, no Meet / Zoom / Chrome session will
 * ever trigger a notification: the watch loop simply isn't running.
 */
let micMonitorStatus: {
  monitorAvailable: boolean;
  monitorLoadError: string | null;
  serviceStarted: boolean;
  serviceStartedAt: number | null;
} = {
  monitorAvailable: false,
  monitorLoadError: null,
  serviceStarted: false,
  serviceStartedAt: null,
};

const PRELOAD_PATH = path.join(__dirname, 'preload.js');
const HUD_HTML = path.join(__dirname, '..', 'renderer', 'hud.html');
const MAIN_HTML = path.join(__dirname, '..', 'renderer', 'index.html');
const HUD_DEV_URL = 'http://localhost:5173/hud.html';
const MAIN_DEV_URL = 'http://localhost:5173/';

/**
 * Map secret name → JobStore.kv key. composition.ts reads via this same
 * convention (`groq_api_key_enc`) when decrypting; keep them in sync.
 */
function secretKvKey(name: 'groq_api_key'): string {
  switch (name) {
    case 'groq_api_key':
      return 'groq_api_key_enc';
  }
}

/**
 * macOS "Space dance": briefly tag the window as joinable to any Space so
 * `show()` lands on the user's *current* Space, then re-pin it. Without
 * this, an explicit show teleports the user back to whichever Space the
 * window was last on — which is what made the failure-notification's Open
 * action (and the HUD's History button) feel like a Space yank when the
 * user had moved to a different Space since the window was last visible.
 *
 * Setting `visibleOnFullScreen: false` keeps the main window out of any
 * other app's fullscreen Space — only the HUD opts in to that.
 */
function showMainWindowOnCurrentSpace(win: BrowserWindow): void {
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    win.show();
    win.setVisibleOnAllWorkspaces(false);
  } else {
    win.show();
  }
}

/**
 * Bring the main window forward on the user's current Space and navigate to
 * the given tab. Used by:
 *   - MAIN_SHOW_SESSIONS_TAB / MAIN_SHOW_HOME IPC channels (HUD buttons).
 *   - The notification click handler (transcription-failed toast).
 *
 * If the main window was destroyed (user closed it), recreate it. The HUD
 * is a BrowserWindow too, so `getAllWindows().length === 0` is never true
 * while the HUD is alive — `mainWindow` is the authoritative reference.
 */
function openMainOnTab(tab: 'recording' | 'dictations' | 'meetings' | 'settings'): void {
  const navigate = (wc: WebContents) => {
    if (!bridge) return;
    try {
      bridge.broadcast(wc, PUSH.NAVIGATE_TAB, { tab });
    } catch {
      /* renderer torn down between emit and broadcast */
    }
  };
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
    // createMainWindow's ready-to-show handler runs the Space dance; we just
    // need to navigate to the requested tab once the renderer is alive.
    mainWindow.webContents.once('did-finish-load', () => {
      if (mainWindow) navigate(mainWindow.webContents);
    });
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  showMainWindowOnCurrentSpace(mainWindow);
  mainWindow.focus();
  navigate(mainWindow.webContents);
}

/**
 * History entry point — wired to the HUD's History button + the failed-
 * transcription notification's Open action. Routes to whichever tab matches
 * the most-recently-touched session's mode (Dictations vs Meetings), falling
 * back to Dictations on a clean install. Also clears the HUD's failed state
 * because the user acknowledged this batch of failures by opening history.
 */
function openSessionsTab(): void {
  let tab: 'dictations' | 'meetings' = 'dictations';
  try {
    const mode = composed?.jobStore.latestSessionMode();
    if (mode === 'meeting') tab = 'meetings';
  } catch {
    /* fall through to default */
  }
  openMainOnTab(tab);
  transcriptionUx?.onHistoryDismissed();
}

/**
 * Home (recording-tab) entry point. Wired to the HUD's small circular Home
 * button. Does NOT dismiss the HUD's failed state — clicking Home is just
 * "open the main app," not "acknowledge failures."
 */
function openHome(): void {
  openMainOnTab('recording');
}

/**
 * Spawn audio-process and return the main-side port plus the child handle.
 */
function spawnAudioProcess(): { child: UtilityProcess; port: MessagePortMain } {
  const entry = path.join(__dirname, '..', 'audio-process', 'entry.js');
  // Pipe stdio explicitly rather than relying on `inherit` — on macOS the
  // utilityProcess inherit-stdio path sometimes drops output entirely. We
  // forward each line through main's own stdout/stderr so it shows up in
  // both the dev terminal and the wrapping pino log via stdout/stderr.
  const child = utilityProcess.fork(entry, [], { stdio: 'pipe' });
  const forward = (stream: NodeJS.ReadableStream | null, sink: NodeJS.WriteStream) => {
    if (!stream) return;
    stream.setEncoding?.('utf8');
    stream.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.length > 0) sink.write(`[audio-process] ${line}\n`);
      }
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);

  const { port1, port2 } = new MessageChannelMain();
  child.once('spawn', () => child.postMessage({ type: 'init' }, [port2]));
  // Surface unexpected exits — without this, audio-process can crash on
  // startup (e.g., native addon ABI mismatch) and main keeps running, leaving
  // sessions that capture nothing.
  child.on('exit', (code) => {
    if (composed) {
      composed.logger.error('audio-process exited', { code });
    } else {
      console.error(`[main] audio-process exited with code ${code}`);
    }
  });
  return { child, port: port1 };
}

/** Adapt MessagePortMain → AudioProcessLink. */
function makeAudioLink(port: MessagePortMain): AudioProcessLink {
  const listeners = new Set<(msg: AudioToMain) => void>();
  port.on('message', (event: Electron.MessageEvent) => {
    const msg = event.data as AudioToMain;
    for (const cb of listeners) cb(msg);
  });
  port.start();
  return {
    send(msg: MainToAudio) {
      port.postMessage(msg);
    },
    on(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
}

/**
 * Build the per-OS platform services bundle. macOS impls; the native mic-activity
 * monitor is wrapped in try/catch so a missing native binary doesn't kill startup
 * — meeting auto-detect just becomes unavailable until the addon is built.
 */
function buildPlatformServices(): PlatformServices {
  const secureStorage = new DarwinSecureStorage();
  const permissions = new DarwinPermissionService();
  const paste = new DarwinPasteService();
  const notifications = new DarwinNotificationService();
  const hotkeys = new DarwinHotkeyManager();
  const deviceMonitor = new DarwinDeviceMonitor();
  let micActivity: IMicActivityMonitor | undefined;
  try {
    // Lazy import keeps the native addon out of the tree when not built.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DarwinMicActivityMonitor } = require('@platform/darwin/DarwinMicActivityMonitor');
    micActivity = new DarwinMicActivityMonitor();
    micMonitorStatus.monitorAvailable = true;
    // Surfaced before the composed logger exists. Console is fine — the
    // pino transport in dev forwards stdout into the structured log too.
    console.info('[main] mic_activity_monitor_ready ok=true');
  } catch (err) {
    // Native addon not built → feature gracefully off. composition.ts handles undefined.
    // Capture WHY so the Settings diagnostic panel can show it instead of a silent void.
    const msg = err instanceof Error ? err.message : String(err);
    micMonitorStatus.monitorLoadError = msg;
    console.warn(`[main] mic_activity_monitor_ready ok=false err=${msg}`);
  }
  // Globe (Fn) key listener — its own Swift binary, separate from uiohook.
  // The DarwinGlobeKeyManager itself is a no-op when the binary is missing.
  const globeKey: IGlobeKeyManager = new DarwinGlobeKeyManager();
  return {
    secureStorage,
    permissions,
    paste,
    notifications,
    hotkeys,
    micActivity,
    globeKey,
    deviceMonitor,
  };
}

/** Build the main browser window with our preload + sandboxed renderer. */
function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 480,
    height: 720,
    show: false,
    backgroundColor: '#09090b',
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  if (process.platform === 'darwin') {
    // Explicit pin to the current Space (the default, but state it so it's
    // not confused with the HUD's setVisibleOnAllWorkspaces(true)). Every
    // show path routes through showMainWindowOnCurrentSpace, which toggles
    // this on/off to land on the user's active Space.
    win.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: false });
  }
  if (process.env.NODE_ENV === 'development') {
    void win.loadURL(MAIN_DEV_URL);
  } else {
    void win.loadFile(MAIN_HTML);
  }
  win.once('ready-to-show', () => showMainWindowOnCurrentSpace(win));
  return win;
}

/** Register all IPC channels against the composed app. */
function wireIpc(b: IpcBridgeMain, c: ComposedApp): void {
  // Settings.
  b.handle(REQUEST.SETTINGS_GET, () => c.settings.load().settings as unknown as SettingsPayload);
  b.handle(REQUEST.SETTINGS_SET, async (input) => {
    const next = input as unknown as AppSettings;
    c.settings.save(next);
    // Onboarding-completion transition (null → timestamp): reveal the HUD
    // and flip the gate that lets hotkeys trigger recording. Subsequent
    // saves are no-ops here because the flag is already true.
    if (!onboardingComplete && next.onboardingCompletedAt) {
      onboardingComplete = true;
      hud?.revealOnActiveDisplay();
    }
    // Hot-reload the primary hotkey if it changed. Avoids the old "restart
    // the app after changing" hint and matches Wispr-style instant feedback.
    const nextHotkey = (next.hotkeys?.primary ?? null) as Hotkey | null;
    if (!hotkeysEqual(primaryHotkey, nextHotkey)) {
      if (primaryHotkeyUnregister) {
        primaryHotkeyUnregister();
        primaryHotkeyUnregister = null;
      }
      primaryHotkey = nextHotkey;
      // A Fn-only hotkey is functionally identical to "no hotkey" — Globe is
      // the always-on path and uiohook can't observe Fn anyway. Only register
      // a uiohook binding for non-Fn hotkeys.
      if (nextHotkey && !isFnOnlyHotkey(nextHotkey)) {
        primaryHotkeyUnregister = registerPrimaryHotkey(c, nextHotkey);
      }
      // Push to all renderers so the HUD chip + future hints refresh live.
      broadcastHotkeyChanged(nextHotkey);
    }
    return {};
  });
  b.handle(REQUEST.SETTINGS_SET_SECRET, ({ name, value }) => {
    // Empty string CLEARS the secret. Otherwise we encrypt and persist.
    const kvKey = secretKvKey(name);
    if (value.length === 0) {
      c.jobStore.deleteKv(kvKey);
      return {};
    }
    if (!c.platform.secureStorage.isAvailable()) {
      throw new Error('OS keyring is not available; cannot persist secret');
    }
    const enc = c.platform.secureStorage.encrypt(value);
    c.jobStore.setKv(kvKey, enc);
    return {};
  });
  b.handle(REQUEST.SETTINGS_HAS_SECRET, ({ name }) => {
    return { present: c.jobStore.getKv(secretKvKey(name)) !== undefined };
  });

  // Sessions.
  b.handle(REQUEST.SESSION_LIST, ({ limit }) => ({
    sessions: c.jobStore.listSessionsWithFailureCounts(limit ?? 50).map((s) => ({
      id: s.id,
      mode: s.mode,
      status: s.status,
      startedAt: s.started_at,
      endedAt: s.ended_at,
      title: s.title,
      failedCount: s.failed_count,
    })),
  }));
  b.handle(REQUEST.SESSION_GET, ({ sessionId }) => {
    const r = c.jobStore.getSessionWithTranscripts(sessionId);
    if (!r) throw new Error(`session ${sessionId} not found`);
    return {
      id: r.session.id,
      mode: r.session.mode,
      status: r.session.status,
      startedAt: r.session.started_at,
      endedAt: r.session.ended_at,
      title: r.session.title,
      // SessionGetOutput extends SessionListItem which now carries failedCount.
      // For the detail view we surface the per-session count too.
      failedCount: c.jobStore.countFailedChunks(sessionId),
      transcripts: r.transcripts,
    };
  });
  b.handle(REQUEST.SESSION_DELETE, ({ sessionId }) => {
    c.jobStore.deleteSession(sessionId);
    return {};
  });
  b.handle(REQUEST.SESSION_UPDATE_TITLE, ({ sessionId, title }) => {
    // Trim then collapse empty string → null so the UI shows the "Untitled
    // <mode>" fallback consistently regardless of whether the user typed
    // nothing or whitespace.
    const cleaned = title === null ? null : title.trim() === '' ? null : title.trim();
    c.jobStore.updateSessionTitle(sessionId, cleaned);
    return {};
  });
  b.handle(REQUEST.DICTATION_LIST, ({ limit }) => ({
    dictations: c.jobStore.listDictationsWithTranscripts(limit ?? 50),
  }));
  b.handle(REQUEST.SESSION_RETRY_FAILED, ({ sessionId }) => {
    const retriedIds = c.jobStore.resetFailedToCaptured(sessionId);
    if (retriedIds.length > 0) {
      transcriptionUx?.onRetryRequested(sessionId, retriedIds);
    }
    return { retried: retriedIds.length };
  });
  b.handle(REQUEST.MAIN_SHOW_SESSIONS_TAB, () => {
    openSessionsTab();
    return {};
  });
  b.handle(REQUEST.MAIN_SHOW_HOME, () => {
    openHome();
    return {};
  });
  b.handle(REQUEST.HOTKEY_CAPTURE_BEGIN, (_input, ctx) => {
    // Bind capture to this renderer's webContents. If a previous capture
    // didn't end cleanly (renderer crashed), this replaces the dangling ref.
    // Watching 'destroyed' clears the ref defensively too.
    const sender = ctx?.sender as WebContents | undefined;
    hotkeyCaptureWebContents = sender ?? null;
    sender?.once('destroyed', () => {
      if (hotkeyCaptureWebContents === sender) {
        hotkeyCaptureWebContents = null;
      }
    });
    return {};
  });
  b.handle(REQUEST.HOTKEY_CAPTURE_END, (_input, ctx) => {
    const sender = ctx?.sender as WebContents | undefined;
    if (!sender || hotkeyCaptureWebContents === sender) {
      hotkeyCaptureWebContents = null;
    }
    return {};
  });
  b.handle(REQUEST.RECORDING_LIST_INPUT_DEVICES, () => {
    // Lazy-require to keep the native addon out of the tree when not built.
    // Returns [] if the addon failed to load or there are no input devices.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const native = require('@twinmind/coreaudio-darwin') as {
        listInputDevices?: () => Array<{ id: string; name: string; isDefault: boolean }>;
      };
      const devices = typeof native.listInputDevices === 'function' ? native.listInputDevices() : [];
      return { devices };
    } catch {
      return { devices: [] };
    }
  });
  b.handle(REQUEST.SYSTEM_GET_FN_USAGE, () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const native = require('@twinmind/coreaudio-darwin') as {
        fnUsageType?: () => { get: () => number | null };
      };
      const value = native.fnUsageType?.().get() ?? null;
      return { value };
    } catch {
      return { value: null };
    }
  });
  b.handle(REQUEST.SYSTEM_SET_FN_USAGE, (input) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const native = require('@twinmind/coreaudio-darwin') as {
        fnUsageType?: () => { set: (v: number) => boolean };
      };
      const ok = native.fnUsageType?.().set(input.value) ?? false;
      return { ok };
    } catch {
      return { ok: false };
    }
  });
  b.handle(REQUEST.DIAGNOSTIC_MEETING_DETECTION_STATUS, () => {
    const rows = c.jobStore.listMicActivityEvents(50);
    return {
      monitorAvailable: micMonitorStatus.monitorAvailable,
      monitorLoadError: micMonitorStatus.monitorLoadError,
      serviceStarted: micMonitorStatus.serviceStarted,
      serviceStartedAt: micMonitorStatus.serviceStartedAt,
      recentEvents: rows.map((r) => ({
        id: r.id,
        occurredAt: r.occurred_at,
        state: r.state,
        sourcePid: r.source_pid,
        sourceBundle: r.source_bundle,
        meta: r.meta,
      })),
    };
  });

  // Recording. Every start path also checks transcriptionUx — we don't start
  // a new session while chunks from the previous one are still being
  // processed (the user explicitly asked for this gate).
  b.handle(REQUEST.REC_START_DICTATION, () => {
    if (transcriptionUx?.isBlockingNewRecording()) return {};
    c.orchestrator.startDictation();
    hud?.revealOnActiveDisplay();
    return {};
  });
  b.handle(REQUEST.REC_STOP_DICTATION, () => {
    c.orchestrator.stop();
    return {};
  });
  b.handle(REQUEST.REC_START_MEETING, ({ title }) => {
    if (transcriptionUx?.isBlockingNewRecording()) {
      // Throwing surfaces in the renderer as a rejected promise; the dashboard's
      // try/finally already swallows it. The HUD spinner is the user-visible signal.
      throw new Error('Busy processing previous recording');
    }
    const sessionId = c.orchestrator.startMeeting({ title });
    hud?.revealOnActiveDisplay();
    return { sessionId };
  });
  b.handle(REQUEST.REC_STOP_MEETING, ({ sessionId }) => {
    if (c.orchestrator.currentSessionId === sessionId) c.orchestrator.stop();
    return {};
  });

  // Permissions.
  b.handle(REQUEST.PERMISSIONS_REQUEST_MIC, async () => ({
    granted: (await c.platform.permissions.request('mic')) === 'granted',
  }));
  b.handle(REQUEST.PERMISSIONS_REQUEST_AUDIO_CAP, async () => ({
    granted: await probeSystemAudio(c.logger),
  }));
  b.handle(REQUEST.PERMISSIONS_REQUEST_ACCESSIBILITY, async () => {
    // Surface the macOS prompt only. It has its own "Open System Settings"
    // button that the user clicks to reach the Accessibility pane — the
    // prompt + that button is the standard Apple-blessed flow. Previously
    // we also called openSystemSettings('accessibility') here, which opened
    // the pane TOO; the user then clicked the prompt's button and the pane
    // opened a *second* time. One mechanism is enough.
    //
    // Side-effect we still rely on: this call registers `com.twinmind.app`
    // in the TCC database so it appears in the Accessibility list (just
    // unchecked) the moment the pane opens. Result is usually `false` —
    // user still has to flip the toggle. Onboarding polls afterwards.
    const grant = await c.platform.permissions.request('accessibility');
    return { granted: grant === 'granted' };
  });
  b.handle(REQUEST.PERMISSIONS_REQUEST_NOTIFICATIONS, async () => {
    // No macOS API to query notifications state from Electron. Showing a
    // silent Notification surfaces the OS prompt the first time; we then
    // report granted optimistically (user can still deny in System Settings
    // — that just makes future show()s a no-op, no crash).
    try {
      const { Notification: ElectronNotification } = await import('electron');
      if (ElectronNotification.isSupported()) {
        const n = new ElectronNotification({
          title: 'TwinMind',
          body: "You're all set to receive meeting notifications.",
          silent: true,
        });
        n.show();
        // Auto-dismiss after a couple seconds so it doesn't linger.
        setTimeout(() => {
          try {
            n.close();
          } catch {
            /* already gone */
          }
        }, 2000);
      }
    } catch (err) {
      c.logger.warn('notifications request: show failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return { granted: true };
  });
  b.handle(REQUEST.PERMISSIONS_READ, async ({ kind }) => ({
    grant: c.platform.permissions.read(kind),
  }));
  b.handle(REQUEST.PERMISSIONS_OPEN_SYSTEM_SETTINGS, async ({ kind }) => {
    await c.platform.permissions.openSystemSettings(kind);
    return {};
  });

  // Diagnostic + danger-zone.
  b.handle(REQUEST.DIAGNOSTIC_EXPORT_BUNDLE, () => ({
    path: path.join(c.userDataDir, 'crash-bundles'),
  }));
  b.handle(REQUEST.HUD_BEGIN_DRAG, () => {
    hud?.beginDrag();
    return {};
  });
  b.handle(REQUEST.HUD_DRAG_MOVE_BY, ({ dx, dy }) => {
    hud?.dragMoveBy(dx, dy);
    return {};
  });
  b.handle(REQUEST.HUD_END_DRAG, () => {
    hud?.endDrag();
    return {};
  });
  b.handle(REQUEST.HUD_SET_MOUSE_IGNORE, ({ ignore }) => {
    hud?.setMouseIgnore(ignore);
    return {};
  });
  b.handle(REQUEST.DATA_DELETE_EVERYTHING, async () => {
    c.logger.warn('data.deleteEverything invoked — full nuke');

    // 1. Stop any in-flight recording so we're not racing the audio-process.
    if (c.orchestrator.state === 'recording') {
      c.orchestrator.stop('user_wipe');
    }

    // 2. Pause the upload queue so it can't transition rows while we wipe.
    await c.uploadQueue.stop();

    // 3. Wipe DB rows in a single transaction.
    c.jobStore.wipeAll();

    // 4. Delete every file under <userData>/recordings (best-effort).
    const recDir = path.join(c.userDataDir, 'recordings');
    try {
      fs.rmSync(recDir, { recursive: true, force: true });
      fs.mkdirSync(recDir, { recursive: true, mode: 0o700 });
    } catch (e) {
      c.logger.error('failed to clear recordings dir', { err: String(e) });
    }

    // 5. Restart the queue so the user can keep using the app.
    c.uploadQueue.start();

    c.analytics.track('data_deleted', {});
    return {};
  });
}

/**
 * Push recording_state_changed to every live webContents (HUD + main window).
 */
function broadcastRecordingState(b: IpcBridgeMain, c: ComposedApp): void {
  const snap = c.orchestrator.snapshot();
  const targets: WebContents[] = [
    ...BrowserWindow.getAllWindows().map((w) => w.webContents),
  ];
  if (hud) targets.push(hud.webContents());
  for (const wc of targets) {
    try {
      b.broadcast(wc, PUSH.RECORDING_STATE, {
        state: snap.state === 'idle' ? 'ended' : snap.state,
        mode: snap.mode,
        ...(snap.sessionId ? { sessionId: snap.sessionId } : {}),
        elapsedMs: snap.elapsedMs,
      });
    } catch {
      // Renderer may have torn down between emit and broadcast.
    }
  }
}

/**
 * Compose a HotkeyGestureRecognizer + the orchestrator gestures it drives,
 * register it via the platform hotkey manager, and return the unregister
 * callback. Used both by initial wireBehaviors and by the SETTINGS_SET
 * handler for hot-reload when the user captures a new hotkey.
 */
/**
 * Fn-only hotkey ({ modifiers:['Fn'], key:null }) is functionally identical
 * to "no hotkey": macOS doesn't expose Fn through uiohook on Cocoa, so we
 * can't register a binding for it. Globe (always-on) handles Fn instead.
 */
function isFnOnlyHotkey(h: Hotkey): boolean {
  return h.modifiers.length === 1 && h.modifiers[0] === 'Fn' && h.key === null;
}

/**
 * Probe macOS system-audio capture permission by briefly running audiotee.
 * macOS 14.2+ has no introspection API for `NSAudioCaptureUsageDescription`;
 * the OS only triggers the prompt when an actual capture attempt is made.
 * First PCM frame = granted; emit error or 4s timeout = denied.
 */
async function probeSystemAudio(logger: ComposedApp['logger']): Promise<boolean> {
  type AudioTeeCtor = new (opts: {
    sampleRate: number;
    chunkDurationMs: number;
    binaryPath?: string;
  }) => {
    on(event: 'data', cb: (b: Buffer) => void): unknown;
    on(event: 'error', cb: (e: unknown) => void): unknown;
    start(): Promise<void> | void;
    stop(): Promise<void> | void;
  };
  let AudioTee: AudioTeeCtor;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('audiotee') as { AudioTee?: AudioTeeCtor; default?: AudioTeeCtor };
    const ctor = mod.AudioTee ?? mod.default ?? (mod as unknown as AudioTeeCtor);
    if (typeof ctor !== 'function') throw new Error('audiotee export not a constructor');
    AudioTee = ctor;
  } catch (err) {
    logger.warn('audio-cap probe: audiotee unavailable', {
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }

  const binaryPath = resolveAudioteeBinaryPath() ?? undefined;
  logger.info('audio-cap probe: starting', { binaryPath: binaryPath ?? null });
  const tee = new AudioTee({ sampleRate: 16_000, chunkDurationMs: 100, binaryPath });

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (granted: boolean) => {
      if (settled) return;
      settled = true;
      try {
        void tee.stop();
      } catch {
        /* best-effort */
      }
      resolve(granted);
    };
    tee.on('data', () => finish(true));
    tee.on('error', (e) => {
      logger.info('audio-cap probe: error', {
        message: e instanceof Error ? e.message : String(e),
      });
      finish(false);
    });
    setTimeout(() => finish(false), 4000);

    try {
      const p = tee.start();
      if (p && typeof (p as Promise<void>).then === 'function') {
        (p as Promise<void>).catch((e) => {
          logger.info('audio-cap probe: start rejected', {
            message: e instanceof Error ? e.message : String(e),
          });
          finish(false);
        });
      }
    } catch (err) {
      logger.info('audio-cap probe: start threw', {
        message: err instanceof Error ? err.message : String(err),
      });
      finish(false);
    }
  });
}

/** Push the new primary hotkey to every renderer so chips refresh live. */
function broadcastHotkeyChanged(next: Hotkey | null): void {
  if (!bridge) return;
  const payload = { primary: next };
  const targets: WebContents[] = [];
  if (hud) targets.push(hud.webContents());
  for (const w of BrowserWindow.getAllWindows()) targets.push(w.webContents);
  for (const wc of targets) {
    try {
      bridge.broadcast(wc, PUSH.HOTKEY_CHANGED, payload);
    } catch {
      /* renderer gone */
    }
  }
}

function registerPrimaryHotkey(c: ComposedApp, hotkey: Hotkey): () => void {
  let primaryHoldStarted = false;
  const gesture = new HotkeyGestureRecognizer({
    onHoldStart: () => {
      if (c.orchestrator.state === 'idle' && !transcriptionUx?.isBlockingNewRecording()) {
        c.orchestrator.startDictation();
        hud?.revealOnActiveDisplay();
        primaryHoldStarted = true;
      }
    },
    onHoldEnd: () => {
      if (primaryHoldStarted && c.orchestrator.state === 'recording') {
        c.orchestrator.stop('user');
      }
      primaryHoldStarted = false;
    },
    onDoubleTap: () => {
      if (c.orchestrator.state === 'idle' && !transcriptionUx?.isBlockingNewRecording()) {
        c.orchestrator.startMeeting();
        hud?.revealOnActiveDisplay();
      }
    },
    onSingleTap: () => {
      if (
        c.orchestrator.state === 'recording' &&
        c.orchestrator.snapshot().mode === 'meeting'
      ) {
        c.orchestrator.stop('user');
      }
    },
  });
  return c.platform.hotkeys.registerPressRelease({
    hotkey,
    onPress: () => {
      // Skip while user is still in onboarding — see comment in the Globe
      // press handler for the rationale.
      if (!onboardingComplete) return;
      gesture.press();
    },
    onRelease: () => {
      if (!onboardingComplete) return;
      gesture.release();
    },
  });
}

/**
 * Wire higher-order behavior that crosses module boundaries:
 *   - hotkeys → orchestrator
 *   - power monitor → orchestrator + resume prompt
 *   - meeting-detection → notification → orchestrator (or auto-start)
 *   - dictation completion → paste service
 *   - device-change events → device monitor → orchestrator (forward)
 */
function wireBehaviors(c: ComposedApp): void {
  // ─── Hotkeys ────────────────────────────────────────────────────────────
  // The configurable hotkey (settings.hotkeys.primary) is *opt-in* — out of
  // the box only the Globe (Fn) key triggers recording. If the user captures
  // a hotkey in Settings → Hotkeys, we register the same gesture set on it:
  // hold → dictation, double-tap → meeting, single-tap → stop.
  //
  // Re-applied via applyPrimaryHotkey whenever SETTINGS_SET changes the
  // binding, so the user doesn't need to restart the app.
  primaryHotkey = c.settings.load().settings.hotkeys.primary;
  if (primaryHotkey && !isFnOnlyHotkey(primaryHotkey)) {
    primaryHotkeyUnregister = registerPrimaryHotkey(c, primaryHotkey);
  }

  // ─── Globe (Fn) key: same gesture set as the primary hotkey ─────────────
  // Hold → dictation, double-tap → start meeting, single-tap → stop meeting.
  // Routed through its own HotkeyGestureRecognizer so the timer state is
  // independent of the primary hotkey (different physical key, can be
  // pressed concurrently).
  //
  // Gated by `primaryHotkey`: if the user has configured a primary, the Fn
  // key is silenced. The configured hotkey replaces Fn, never duplicates it.
  // Clearing the primary in Settings re-enables Fn instantly.
  if (c.platform.globeKey) {
    const globe = c.platform.globeKey;
    let globeHoldStarted = false;
    const globeGesture = new HotkeyGestureRecognizer({
      onHoldStart: () => {
        if (c.orchestrator.state === 'idle' && !transcriptionUx?.isBlockingNewRecording()) {
          c.orchestrator.startDictation();
          hud?.revealOnActiveDisplay();
          globeHoldStarted = true;
        }
      },
      onHoldEnd: () => {
        if (globeHoldStarted && c.orchestrator.state === 'recording') {
          c.orchestrator.stop('user');
        }
        globeHoldStarted = false;
      },
      onDoubleTap: () => {
        if (c.orchestrator.state === 'idle' && !transcriptionUx?.isBlockingNewRecording()) {
          c.orchestrator.startMeeting();
          hud?.revealOnActiveDisplay();
        }
      },
      onSingleTap: () => {
        if (c.orchestrator.state === 'recording' && c.orchestrator.snapshot().mode === 'meeting') {
          c.orchestrator.stop('user');
        }
      },
    });
    globe.start();
    // Silence Globe only when the user has picked a *different* hotkey. A
    // Fn-only primary means "use Fn" — Globe is exactly what we want firing.
    const globeSuppressed = () => primaryHotkey !== null && !isFnOnlyHotkey(primaryHotkey);
    globe.onPress(() => {
      // Capture-mode override: route the Fn press to the picker instead of
      // the gesture. Takes priority over the suppression check — the picker
      // needs Fn events regardless of the currently-installed primary.
      if (hotkeyCaptureWebContents && bridge) {
        try {
          bridge.broadcast(hotkeyCaptureWebContents, PUSH.HOTKEY_CAPTURE_KEY, {
            kind: 'down',
            code: 'Fn',
          });
        } catch {
          /* renderer torn down */
        }
        return;
      }
      if (globeSuppressed()) return;
      // Block hotkey-triggered recording while the user is still in
      // onboarding. Onboarding has its own UI; Fn shouldn't kick off a
      // session behind it.
      if (!onboardingComplete) return;
      globeGesture.press();
    });
    globe.onRelease(() => {
      if (hotkeyCaptureWebContents && bridge) {
        try {
          bridge.broadcast(hotkeyCaptureWebContents, PUSH.HOTKEY_CAPTURE_KEY, {
            kind: 'up',
            code: 'Fn',
          });
        } catch {
          /* renderer torn down */
        }
        return;
      }
      if (globeSuppressed()) return;
      if (!onboardingComplete) return;
      globeGesture.release();
    });
  }

  // ─── Power monitor ──────────────────────────────────────────────────────
  const power = new PowerMonitorAdapter({
    powerMonitor,
    orchestrator: c.orchestrator,
    store: c.jobStore,
    logger: c.logger,
  });
  power.onResumePrompt((e) => {
    c.platform.notifications.show(
      {
        title: 'Resume recording?',
        body: 'Your recording was paused when the Mac went to sleep.',
        actions: [
          { id: 'resume', label: 'Resume' },
          { id: 'end', label: 'End' },
        ],
        autoDismissMs: 60_000,
      },
      (action) => {
        if (action === 'resume') {
          // Start a fresh session; recovery already ended the old one or it
          // will time-out per §11.5 auto-end. Real "stitch" of old+new
          // sessions is a future enhancement.
          c.orchestrator.startMeeting({ title: `Resumed from ${e.sessionId.slice(0, 8)}` });
          hud?.revealOnActiveDisplay();
        }
      },
    );
  });

  // ─── Meeting auto-detection ─────────────────────────────────────────────
  if (c.meetingDetection) {
    c.meetingDetection.onMeetingDetected((evt) => {
      c.analytics.track('meeting_notification_shown', { trigger: 'mic_activity' });
      const cfg = c.settings.load().settings;
      // Auto-start mode: skip the notification entirely.
      if (cfg.meetingDetection.autoStart) {
        c.orchestrator.startMeeting();
        c.meetingDetection?.recordOutcome(evt.promptId, 'accepted');
        c.analytics.track('meeting_notification_outcome', { action: 'accepted' });
        hud?.revealOnActiveDisplay();
        return;
      }
      c.platform.notifications.show(
        {
          title: 'Recording detected',
          body: 'Start a meeting note?',
          // Single inline "Start" action plus a labelled close button so both
          // affordances surface on macOS Banner-style notifications (multi-
          // action arrays get folded into an Options dropdown otherwise).
          actions: [{ id: 'start', label: 'Start' }],
          closeButtonText: 'Dismiss',
          autoDismissMs: 60_000,
        },
        (action) => {
          const outcome =
            action === 'start'
              ? 'accepted'
              : action === '__timed_out__'
                ? 'timed_out'
                : 'dismissed';
          c.meetingDetection?.recordOutcome(evt.promptId, outcome);
          c.analytics.track('meeting_notification_outcome', { action: outcome });
          if (outcome === 'accepted') {
            c.orchestrator.startMeeting();
            hud?.revealOnActiveDisplay();
          }
        },
      );
    });
  }

  // ─── Chunk completion → paste (dictation) + broadcast (all modes) ───────
  c.uploadQueue.on('chunk_completed', (e) => {
    // Drive the retry/notification state machine before doing anything else.
    transcriptionUx?.onChunkCompleted(e.chunkId);
    if (e.segment.text.trim() === '') return;
    const chunk = c.jobStore.getChunk(e.chunkId);
    if (!chunk) return;
    // Paste only for dictation (mic source); meetings stay in the Sessions tab.
    if (chunk.source === 'mic') {
      void c.platform.paste.paste(e.segment.text);
    }
    // Broadcast to every live renderer so the SessionDetail / HUD can update
    // incrementally as chunks land, instead of waiting for the session to end.
    if (bridge) {
      const payload = {
        sessionId: e.sessionId,
        chunkId: e.chunkId,
        source: chunk.source,
        startMs: chunk.start_ms,
        endMs: chunk.end_ms,
        text: e.segment.text,
      };
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          bridge.broadcast(win.webContents, PUSH.TRANSCRIPT_SEGMENT, payload);
        } catch {
          /* renderer torn down between emit + broadcast */
        }
      }
      if (hud) {
        try {
          bridge.broadcast(hud.webContents(), PUSH.TRANSCRIPT_SEGMENT, payload);
        } catch {
          /* HUD torn down */
        }
      }
    }
  });

  // ─── Permanent chunk failures → retry UX state machine ─────────────────
  c.uploadQueue.on('chunk_failed_permanent', (e) => {
    transcriptionUx?.onChunkFailedPermanent(e.chunkId, e.errorClass);
  });

  // ─── Device-change events ───────────────────────────────────────────────
  // The audio-process emits `device_change` messages; forward them to the
  // platform monitor so anything that needs them (UI toasts, telemetry) has
  // a single subscription point.
  c.platform.deviceMonitor.start();
}

app.whenReady().then(() => {
  const spawned = spawnAudioProcess();
  audioProcessHandle = spawned.child;
  audioPort = spawned.port;

  const audioLink = makeAudioLink(audioPort);

  // Surface audio-process `device_change` to the DarwinDeviceMonitor for
  // unified event distribution (registered before compose so deviceMonitor
  // can receive events as soon as it starts).
  const platform = buildPlatformServices();
  audioLink.on((msg) => {
    if (msg.type === 'device_change') {
      (platform.deviceMonitor as DarwinDeviceMonitor).emit({
        kind: 'other',
        label: msg.label,
        noDevice: false,
      });
      return;
    }
    if (msg.type === 'amplitude_sample') {
      // Push to the HUD only — main window doesn't need 10 Hz updates.
      if (hud && bridge) {
        try {
          bridge.broadcast(hud.webContents(), PUSH.AMPLITUDE_SAMPLE, { value: msg.value });
        } catch {
          /* HUD torn down between emit and broadcast */
        }
      }
      return;
    }
    if (msg.type === 'chunk_closed') {
      // The orchestrator's link.on listener was registered BEFORE this one
      // (orchestrator subscribes in its constructor; we subscribe in
      // app.whenReady AFTER compose returns). Listeners fan out in insertion
      // order, so by this point ChunkWriter.closeChunk has already persisted
      // the chunk row. Look up its session and let TranscriptionUx re-check
      // whether the session is fully done.
      const chunk = composed?.jobStore.getChunk(msg.chunkId);
      if (chunk && transcriptionUx) transcriptionUx.onChunkPersisted(chunk.session_id);
    }
    if (msg.type === 'mic_rebound') {
      // The audio-process just successfully swapped the mic to whatever the
      // new system default is. Tell the user briefly — recording continues
      // uninterrupted but the audio source changed, which matters if they're
      // about to look back at the transcript and wonder why the second half
      // sounds different.
      if (!composed) return;
      composed.platform.notifications.show(
        {
          title: 'Microphone changed',
          body: "Your input device changed mid-recording. We've switched to the new default and recording continues.",
          actions: [],
          autoDismissMs: 6_000,
        },
        () => {
          /* no actions */
        },
      );
    }
  });

  composed = compose({
    audioLink,
    platform,
    appVersion: app.getVersion(),
  });

  // composition.ts calls meetingDetection.start() inline when it constructs
  // the service — capture the timestamp so the Settings diagnostic panel
  // can show "Service started: HH:MM" vs. "never."
  if (composed.meetingDetection) {
    micMonitorStatus.serviceStarted = true;
    micMonitorStatus.serviceStartedAt = Date.now();
    composed.logger.info('meeting_detection_service_started');
  } else {
    composed.logger.warn('meeting_detection_service_unavailable', {
      reason: micMonitorStatus.monitorLoadError ?? 'platform_micActivity_undefined',
    });
  }

  bridge = new IpcBridgeMain(ipcMain, composed.logger);

  // Construct BEFORE wireBehaviors — it hooks into the upload queue and the
  // SESSION_RETRY_FAILED handler immediately uses it.
  transcriptionUx = new TranscriptionUx({
    store: composed.jobStore,
    notifications: composed.platform.notifications,
    broadcastToHud: (state) => {
      // The "ui state" is consumed by two surfaces: the HUD (visual) and the
      // main window's Sessions list (auto-refresh on transitions). Fan out to
      // both. Without main-window delivery the row's Retry button wouldn't
      // reappear after a failed retry until the user re-navigated tabs.
      if (!bridge) return;
      const targets: WebContents[] = [];
      if (hud) targets.push(hud.webContents());
      for (const w of BrowserWindow.getAllWindows()) targets.push(w.webContents);
      for (const wc of targets) {
        try {
          bridge.broadcast(wc, PUSH.TRANSCRIPTION_UI_STATE, state);
        } catch {
          /* renderer gone */
        }
      }
    },
    openSessionsTab,
  });

  wireIpc(bridge, composed);
  wireBehaviors(composed);

  // Seed the onboarding flag from disk before constructing the HUD so it
  // stays hidden when the user is still in the wizard.
  onboardingComplete = composed.settings.load().settings.onboardingCompletedAt !== null;
  hud = new FloatingHudWindow(
    PRELOAD_PATH,
    HUD_HTML,
    process.env.NODE_ENV === 'development' ? HUD_DEV_URL : undefined,
    onboardingComplete,
  );
  mainWindow = createMainWindow();

  // Menu-bar tray with Home + Quit. Created after openHome is wired (it's
  // a top-level function in this file, hoisted, so order doesn't matter
  // for the reference itself). Tray construction is no-op on platforms
  // where it isn't supported.
  tray = new TrayManager({ onOpenHome: () => openHome() });
  tray.init();

  // We intentionally don't seed the HUD's failed state from past DB failures.
  // The user has already seen those (or has them visible in the Sessions tab);
  // surfacing them on every launch would be a re-notification of stale state.

  // Track the previous snapshot so we can detect the recording → idle
  // transition. We need the *previous* sessionId because `snap.sessionId`
  // becomes null at the moment state hits 'idle'.
  // Capture elapsedMs from the LAST snap that still had an active session —
  // by the time `idle` fires, the orchestrator has already cleared `active`
  // so its snap reports `elapsedMs: 0`. TranscriptionUx uses this to decide
  // whether a stop was a real recording or a phantom (user pressed the
  // hotkey just long enough to trigger hold-start, then released).
  let prevSnap: { sessionId: string | null; elapsedMs: number } | null = null;
  composed.orchestrator.on('state_changed', (snap) => {
    if (bridge && composed) broadcastRecordingState(bridge, composed);
    if (prevSnap?.sessionId && snap.sessionId === null && transcriptionUx) {
      transcriptionUx.onRecordingStopped(prevSnap.sessionId, prevSnap.elapsedMs);
    }
    prevSnap = { sessionId: snap.sessionId, elapsedMs: snap.elapsedMs };
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event) => {
  if (!composed) return;
  event.preventDefault();
  tray?.destroy();
  hud?.destroy();
  audioProcessHandle?.kill();
  await composed.shutdown();
  composed = null;
  app.exit(0);
});

app.on('activate', () => {
  // The HUD is a BrowserWindow too, so `getAllWindows().length === 0` is
  // never true while the app is running. Track the main window explicitly
  // and recreate / reveal as appropriate when the user dock-clicks.
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
    return;
  }
  if (!mainWindow.isVisible()) {
    showMainWindowOnCurrentSpace(mainWindow);
  }
});
