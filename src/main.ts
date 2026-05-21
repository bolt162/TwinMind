// Load `.env` BEFORE anything else reads `process.env`. The bundled
// main.js sees `dotenv/config` as a side-effect import which calls
// `dotenv.config({ path: process.cwd() + '/.env' })` synchronously.
// In dev, `process.cwd()` is the repo root. In a packaged build there's no
// `.env` and dotenv silently no-ops — production reads from real env.
import 'dotenv/config';

/**
 * main.ts — Electron entry point.
 *
 * Architecture: §4 (three processes), §5 (composition wires services from
 * interfaces), §7.10 (power events), §8 (meeting auto-detect), §16.1
 * (onboarding gate before recording). Plus the multi-user split: Shell is
 * machine-scoped; ComposedApp is per-user and rebuilt every sign-in.
 *
 * Responsibilities (in order):
 *   1. `app.whenReady` → spawn the audio-process utility process.
 *   2. Build platform services (Darwin impls).
 *   3. Build shell (logger, crash, analytics, globalDb, authProvider).
 *   4. Initialize the auth provider; rehydrate from globalDb if applicable.
 *   5. If authenticated, build the per-user `ComposedApp` and wire all the
 *      composed-dependent behaviors (hotkeys, power monitor, meeting-detect,
 *      paste, device-change, transcription UX, upload queue listeners).
 *   6. Wire IPC handlers — auth/wizard ones always available, data-touching
 *      ones gated by `requireComposed()` so signed-out callers get a clean
 *      `not_signed_in` error rather than a null-deref crash.
 *   7. On auth_state_changed: dispose the old composed bindings, build the
 *      new ones. Broadcast AUTH_STATE_CHANGED to all windows.
 *   8. At quit, tear down composed → shell → audio-process.
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

import { buildShell, type ComposedApp, type PlatformServices, type Shell } from './composition';
import { resolveTwinMindBackendConfig } from '@core/auth/twinmindBackendConfig';
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

// Isolate V2 userData from any V1 install. See HANDOFF / commit notes for why.
app.setPath('userData', path.join(app.getPath('appData'), 'TwinMind-V2'));

// ─── twinmind:// custom protocol (sign-in callback) ─────────────────────────
//
// Sign-in flow: the system browser opens the TwinMind webapp; the webapp
// completes Google OAuth and redirects to `twinmind://auth/callback?token=…`.
// macOS LaunchServices routes that URL back to whichever app most recently
// registered for the `twinmind` scheme (V1 also uses it — last-writer wins,
// which the user has accepted).
//
// `setAsDefaultProtocolClient` MUST be called synchronously at module load,
// before `app.whenReady()` resolves, otherwise a click on the redirect URL
// during cold-launch can miss us. The `defaultApp` branch handles `npm run
// dev`, where Electron is launched with the entry script path in argv —
// we have to pass the resolved entry-script path so the OS knows how to
// re-launch the dev binary.
const AUTH_SCHEME = 'twinmind';
if (process.defaultApp) {
  if (process.argv.length >= 2 && typeof process.argv[1] === 'string') {
    app.setAsDefaultProtocolClient(AUTH_SCHEME, process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient(AUTH_SCHEME);
}

// Single-instance lock. Without it, clicking a `twinmind://` link while the
// app is already running spawns a SECOND Electron process, which then has
// its own (empty) auth state and confused windows. With the lock, the OS
// routes the new launch's URL through `second-instance` on the existing
// process and the duplicate exits.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// Buffer for URLs that arrive BEFORE shell is built (cold-launch via deep
// link). Drained inside `app.whenReady()` once `shell.authProvider` exists.
let pendingAuthCallbackUrl: string | null = null;

function routeAuthCallback(url: string): void {
  if (!url.startsWith(`${AUTH_SCHEME}://`)) return;
  if (!shell) {
    pendingAuthCallbackUrl = url;
    return;
  }
  shell.authProvider.deliverAuthCallback(url);
}

// macOS routes deep links through this event for both cold-launch (queued
// before whenReady) and warm dispatch (existing instance).
app.on('open-url', (event, url) => {
  event.preventDefault();
  routeAuthCallback(url);
});

// Windows/Linux: the URL arrives as an argv entry on the SECOND instance,
// which the OS routes through this event on the primary. macOS includes
// `additionalData` for some cases too; we keep it cross-platform by
// scanning argv. Bring the main window forward so the user sees the result.
app.on('second-instance', (_event, argv) => {
  const url = argv.find((a) => typeof a === 'string' && a.startsWith(`${AUTH_SCHEME}://`));
  if (url) routeAuthCallback(url);
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    showMainWindowOnCurrentSpace(mainWindow);
    mainWindow.focus();
  }
});

// ─── Module-level state ─────────────────────────────────────────────────────

let shell: Shell | null = null;
let composed: ComposedApp | null = null;
let composedBindings: ComposedBindings | null = null;
let mainWindow: BrowserWindow | null = null;
let hud: FloatingHudWindow | null = null;
let audioProcessHandle: UtilityProcess | null = null;
let audioPort: MessagePortMain | null = null;
let bridge: IpcBridgeMain | null = null;
let tray: TrayManager | null = null;

/**
 * Machine-scoped UI gate. True once the wizard has been completed at least
 * once on this machine. Gates the HUD's `revealOnActiveDisplay` so the
 * floating button doesn't appear during onboarding. Read from
 * `globalDb.wizard.onboarding_completed_at` at startup; flipped by the
 * WIZARD_COMPLETE IPC handler.
 */
let onboardingComplete = false;

/**
 * Set by HOTKEY_CAPTURE_BEGIN. While non-null, the Globe (Fn) handler
 * forwards Fn down/up events here as HOTKEY_CAPTURE_KEY pushes instead of
 * running them through the gesture recognizer.
 */
let hotkeyCaptureWebContents: WebContents | null = null;

/**
 * Diagnostic status for meeting-detection. Surfaced via the
 * DIAGNOSTIC_MEETING_DETECTION_STATUS IPC.
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

// ─── ComposedBindings ────────────────────────────────────────────────────────

/**
 * Bundle of everything wired up FOR a specific composed app. Built on every
 * sign-in; disposed on sign-out. Holds the unregister callbacks for hotkeys
 * + globe key + power monitor + per-user upload-queue subscriptions, so a
 * clean dispose returns the app to its pre-auth state with no dangling
 * listeners.
 */
interface ComposedBindings {
  readonly transcriptionUx: TranscriptionUx;
  readonly primaryHotkey: Hotkey | null;
  /** Unregister fn for the configurable primary hotkey, if any. */
  readonly primaryHotkeyUnregister: (() => void) | null;
  /** Best-effort dispose for the globe-key gesture subscription, if any. */
  readonly globeKeyDispose: (() => void) | null;
  readonly powerDispose: () => void;
  /** Removes the orchestrator state listener that broadcasts recording state. */
  readonly orchestratorStateDispose: () => void;
  /** Removes the upload-queue listeners (chunk_completed + chunk_failed_permanent). */
  readonly uploadQueueDispose: () => void;
}

// ─── BrowserWindow helpers (unchanged behavior) ─────────────────────────────

function showMainWindowOnCurrentSpace(win: BrowserWindow): void {
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    win.show();
    win.setVisibleOnAllWorkspaces(false);
  } else {
    win.show();
  }
}

function openMainOnTab(tab: 'recording' | 'dictations' | 'meetings' | 'settings'): void {
  const navigate = (wc: WebContents) => {
    if (!bridge) return;
    try {
      bridge.broadcast(wc, PUSH.NAVIGATE_TAB, { tab });
    } catch {
      /* renderer torn down */
    }
  };
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
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

function openSessionsTab(): void {
  let tab: 'dictations' | 'meetings' = 'dictations';
  try {
    const mode = composed?.jobStore.latestSessionMode();
    if (mode === 'meeting') tab = 'meetings';
  } catch {
    /* fall through to default */
  }
  openMainOnTab(tab);
  composedBindings?.transcriptionUx.onHistoryDismissed();
}

function openHome(): void {
  openMainOnTab('recording');
}

// ─── audio-process spawn (unchanged) ────────────────────────────────────────

function spawnAudioProcess(): { child: UtilityProcess; port: MessagePortMain } {
  const entry = path.join(__dirname, '..', 'audio-process', 'entry.js');
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
  child.on('exit', (code) => {
    if (shell) {
      shell.logger.error('audio-process exited', { code });
    } else {
      console.error(`[main] audio-process exited with code ${code}`);
    }
  });
  return { child, port: port1 };
}

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

function buildPlatformServices(): PlatformServices {
  const secureStorage = new DarwinSecureStorage();
  const permissions = new DarwinPermissionService();
  const paste = new DarwinPasteService();
  const notifications = new DarwinNotificationService();
  const hotkeys = new DarwinHotkeyManager();
  const deviceMonitor = new DarwinDeviceMonitor();
  let micActivity: IMicActivityMonitor | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DarwinMicActivityMonitor } = require('@platform/darwin/DarwinMicActivityMonitor');
    micActivity = new DarwinMicActivityMonitor();
    micMonitorStatus.monitorAvailable = true;
    console.info('[main] mic_activity_monitor_ready ok=true');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    micMonitorStatus.monitorLoadError = msg;
    console.warn(`[main] mic_activity_monitor_ready ok=false err=${msg}`);
  }
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

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 480,
    height: 720,
    // Lock the launch dimensions as the minimum — users can grow the window
    // but can't shrink past 480×720. Below that the tile/detail layouts get
    // visually cramped (long titles spill, transcript timestamp + text crowd
    // each other). Larger is fine; smaller is forbidden by the OS resize handles.
    minWidth: 480,
    minHeight: 720,
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
    win.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: false });
  }
  if (process.env.NODE_ENV === 'development') {
    void win.loadURL(MAIN_DEV_URL);
  } else {
    void win.loadFile(MAIN_HTML);
  }
  win.once('ready-to-show', () => {
    if (process.platform === 'darwin') app.dock?.show();
    showMainWindowOnCurrentSpace(win);
  });
  win.on('closed', () => {
    mainWindow = null;
    if (process.platform === 'darwin') app.dock?.hide();
  });
  return win;
}

// ─── IPC: guards + handlers ─────────────────────────────────────────────────

/**
 * Refuse data IPC calls when no user is signed in. The renderer catches the
 * rejected promise and routes to SignInScreen; we do NOT crash on null deref.
 */
function requireComposed(): ComposedApp {
  if (!composed) {
    throw new Error('not_signed_in');
  }
  return composed;
}

function requireShell(): Shell {
  if (!shell) throw new Error('not_initialized');
  return shell;
}

function wireIpc(b: IpcBridgeMain): void {
  // ── Auth (always available — touches shell) ──────────────────────────────
  b.handle(REQUEST.AUTH_GET_STATE, () => requireShell().authProvider.getViewState());
  b.handle(REQUEST.AUTH_SIGN_IN, async () => {
    const r = await requireShell().authProvider.signIn();
    return {
      ok: r.ok,
      ...(r.error ? { error: r.error } : {}),
      ...(r.message ? { message: r.message } : {}),
    };
  });
  b.handle(REQUEST.AUTH_SIGN_OUT, async () => {
    // Sign-out blocks while audio is being captured — abandoning the
    // session mid-record would orphan the in-flight chunk (no chunk row,
    // no transcript, file stuck on disk under the old user's data dir).
    // The renderer's AccountCard shows a modal to the user when it sees
    // `recording_active`. The auto-sign-out path in TwinMindAuthProvider
    // (permanent refresh-token errors) calls signOut() directly and is
    // not affected by this IPC-level guard.
    const orchState = composed?.orchestrator.state ?? 'idle';
    if (orchState === 'starting' || orchState === 'recording' || orchState === 'stopping') {
      return { ok: false, error: 'recording_active' as const };
    }
    await requireShell().authProvider.signOut();
    return { ok: true };
  });
  b.handle(REQUEST.AUTH_CANCEL_SIGN_IN, () => {
    // No-op when no signIn is in flight. The provider aborts whichever
    // signal is current; the in-flight promise resolves with error='cancelled'.
    requireShell().authProvider.cancelSignIn();
    return {};
  });
  b.handle(REQUEST.AUTH_LIST_USERS, () => {
    const rows = requireShell().globalDb.listUsers();
    return {
      users: rows.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        photoUrl: u.photoUrl,
        lastSignedInAt: u.lastSignedInAt,
        hasRefreshToken: u.hasRefreshToken,
      })),
    };
  });

  // ── Wizard (always available — touches globalDb) ─────────────────────────
  b.handle(REQUEST.WIZARD_GET_STATUS, () => ({
    onboardingCompletedAt: requireShell().globalDb.getOnboardingCompletedAt(),
  }));
  b.handle(REQUEST.WIZARD_COMPLETE, () => {
    const s = requireShell();
    s.globalDb.setOnboardingCompletedAt(Date.now());
    onboardingComplete = true;
    hud?.revealOnActiveDisplay();
    return {};
  });

  // ── Permissions (always available — platform.permissions lives on shell) ──
  b.handle(REQUEST.PERMISSIONS_REQUEST_MIC, async () => ({
    granted: (await requireShell().platform.permissions.request('mic')) === 'granted',
  }));
  b.handle(REQUEST.PERMISSIONS_REQUEST_AUDIO_CAP, async () => ({
    granted: await probeSystemAudio(requireShell().logger),
  }));
  b.handle(REQUEST.PERMISSIONS_REQUEST_ACCESSIBILITY, async () => {
    const grant = await requireShell().platform.permissions.request('accessibility');
    return { granted: grant === 'granted' };
  });
  b.handle(REQUEST.PERMISSIONS_REQUEST_NOTIFICATIONS, async () => {
    try {
      const { Notification: ElectronNotification } = await import('electron');
      if (ElectronNotification.isSupported()) {
        const n = new ElectronNotification({
          title: 'TwinMind',
          body: "You're all set to receive meeting notifications.",
          silent: true,
        });
        n.show();
        setTimeout(() => {
          try {
            n.close();
          } catch {
            /* already gone */
          }
        }, 2000);
      }
    } catch (err) {
      requireShell().logger.warn('notifications request: show failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return { granted: true };
  });
  b.handle(REQUEST.PERMISSIONS_READ, async ({ kind }) => ({
    grant: requireShell().platform.permissions.read(kind),
  }));
  b.handle(REQUEST.PERMISSIONS_OPEN_SYSTEM_SETTINGS, async ({ kind }) => {
    await requireShell().platform.permissions.openSystemSettings(kind);
    return {};
  });

  // ── Settings (require composed; settings are per-user) ───────────────────
  b.handle(REQUEST.SETTINGS_GET, () =>
    requireComposed().settings.load().settings as unknown as SettingsPayload,
  );
  b.handle(REQUEST.SETTINGS_SET, async (input) => {
    const c = requireComposed();
    const next = input as unknown as AppSettings;
    c.settings.save(next);
    // Hot-reload the primary hotkey if it changed.
    const nextHotkey = (next.hotkeys?.primary ?? null) as Hotkey | null;
    if (composedBindings && !hotkeysEqual(composedBindings.primaryHotkey, nextHotkey)) {
      // Re-register: dispose old, attach new on the same composed.
      composedBindings.primaryHotkeyUnregister?.();
      const newUnregister =
        nextHotkey && !isFnOnlyHotkey(nextHotkey) ? registerPrimaryHotkey(c, nextHotkey) : null;
      composedBindings = {
        ...composedBindings,
        primaryHotkey: nextHotkey,
        primaryHotkeyUnregister: newUnregister,
      };
      ensureFnFreedIfHotkeyIsFn(nextHotkey, requireShell().logger);
      broadcastHotkeyChanged(nextHotkey);
    }
    c.notifySettingsChanged();
    return {};
  });

  // ── Sessions / dictations / recording (require composed) ─────────────────
  b.handle(REQUEST.SESSION_LIST, ({ limit }) => {
    const c = requireComposed();
    return {
      sessions: c.jobStore.listSessionsWithFailureCounts(limit ?? 50).map((s) => {
        const audioMs = c.jobStore.getMaxChunkEndMsForSession(s.id);
        return {
          id: s.id,
          mode: s.mode,
          status: s.status,
          startedAt: s.started_at,
          endedAt: s.ended_at,
          title: s.title,
          failedCount: s.failed_count,
          audioDurationMs: audioMs > 0 ? audioMs : null,
          summaryStatus: s.summary_status,
          summaryId: s.summary_id,
        };
      }),
    };
  });
  b.handle(REQUEST.SESSION_GET, ({ sessionId }) => {
    const c = requireComposed();
    const r = c.jobStore.getSessionWithTranscripts(sessionId);
    if (!r) throw new Error(`session ${sessionId} not found`);
    const audioMs = c.jobStore.getMaxChunkEndMsForSession(sessionId);
    return {
      id: r.session.id,
      mode: r.session.mode,
      status: r.session.status,
      startedAt: r.session.started_at,
      endedAt: r.session.ended_at,
      title: r.session.title,
      failedCount: c.jobStore.countFailedChunks(sessionId),
      audioDurationMs: audioMs > 0 ? audioMs : null,
      summaryStatus: r.session.summary_status,
      summaryId: r.session.summary_id,
      transcripts: r.transcripts,
    };
  });
  b.handle(REQUEST.SESSION_DELETE, ({ sessionId }) => {
    requireComposed().jobStore.deleteSession(sessionId);
    return {};
  });
  b.handle(REQUEST.SESSION_UPDATE_TITLE, ({ sessionId, title }) => {
    const cleaned = title === null ? null : title.trim() === '' ? null : title.trim();
    requireComposed().jobStore.updateSessionTitle(sessionId, cleaned);
    return {};
  });
  b.handle(REQUEST.DICTATION_LIST, ({ limit }) => {
    const c = requireComposed();
    return {
      dictations: c.jobStore.listDictationsWithTranscripts(limit ?? 50).map((d) => {
        const audioMs = c.jobStore.getMaxChunkEndMsForSession(d.id);
        return { ...d, audioDurationMs: audioMs > 0 ? audioMs : null };
      }),
    };
  });
  b.handle(REQUEST.SESSION_RETRY_FAILED, ({ sessionId }) => {
    const c = requireComposed();
    const retriedIds = c.jobStore.resetFailedToCaptured(sessionId);
    if (retriedIds.length > 0) {
      composedBindings?.transcriptionUx.onRetryRequested(sessionId, retriedIds);
    }
    return { retried: retriedIds.length };
  });
  b.handle(REQUEST.SESSION_RETRY_SUMMARY, async ({ sessionId }) => {
    // Same code path as the auto-trigger. fireSummary refuses to re-enter
    // a 'pending' or 'completed' session, so the user clicking the button
    // multiple times can't double-fire.
    requireComposed();
    await fireSummary(sessionId);
    return {};
  });
  b.handle(REQUEST.SESSION_OPEN_SUMMARY, async ({ sessionId }) => {
    // Main constructs the deep link from the configured TWINMIND_APP_URL and
    // the session id — the renderer never sees a URL it could spoof. We also
    // refuse to open the link until the summary is actually completed so the
    // user doesn't land on a 404 in the web app.
    const c = requireComposed();
    const session = c.jobStore.getSession(sessionId);
    if (!session) throw new Error(`session ${sessionId} not found`);
    if (session.summary_status !== 'completed') {
      throw new Error('Summary not ready');
    }
    const cfgRes = resolveTwinMindBackendConfig();
    if (!cfgRes.ok) {
      throw new Error('Backend not configured');
    }
    const url = `${cfgRes.config.appUrl}/m/${encodeURIComponent(sessionId)}`;
    const { shell: electronShell } = await import('electron');
    await electronShell.openExternal(url);
    return {};
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
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const native = require('@twinmind/coreaudio-darwin') as {
        listInputDevices?: () => Array<{
          id: string;
          name: string;
          isDefault: boolean;
          kind: 'built_in' | 'bluetooth' | 'usb' | 'other';
        }>;
      };
      const devices = typeof native.listInputDevices === 'function' ? native.listInputDevices() : [];
      return { devices };
    } catch {
      return { devices: [] };
    }
  });
  b.handle(REQUEST.DIAGNOSTIC_MEETING_DETECTION_STATUS, () => {
    const c = requireComposed();
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

  b.handle(REQUEST.REC_START_DICTATION, () => {
    const c = requireComposed();
    if (composedBindings?.transcriptionUx.isBlockingNewRecording()) return {};
    c.orchestrator.startDictation();
    hud?.revealOnActiveDisplay();
    return {};
  });
  b.handle(REQUEST.REC_STOP_DICTATION, () => {
    requireComposed().orchestrator.stop();
    return {};
  });
  b.handle(REQUEST.REC_START_MEETING, ({ title }) => {
    const c = requireComposed();
    if (composedBindings?.transcriptionUx.isBlockingNewRecording()) {
      throw new Error('Busy processing previous recording');
    }
    const sessionId = c.orchestrator.startMeeting({ title });
    hud?.revealOnActiveDisplay();
    return { sessionId };
  });
  b.handle(REQUEST.REC_STOP_MEETING, ({ sessionId }) => {
    const c = requireComposed();
    if (c.orchestrator.currentSessionId === sessionId) c.orchestrator.stop();
    return {};
  });
  b.handle(REQUEST.REC_RESUME_FROM_DEVICE_LOSS, ({ sessionId, deviceId }) => {
    const c = requireComposed();
    const current = c.settings.load().settings;
    c.settings.save({
      ...current,
      recording: { ...current.recording, inputDeviceId: deviceId },
    });
    const resumed = c.orchestrator.resumeFromDeviceLoss(deviceId);
    if (resumed !== sessionId) {
      c.logger.warn('resumeFromDeviceLoss: sessionId mismatch or no pending session', {
        requested: sessionId,
        resumed,
      });
    }
    return {};
  });

  b.handle(REQUEST.DIAGNOSTIC_EXPORT_BUNDLE, () => ({
    path: path.join(requireComposed().userDataDir, 'crash-bundles'),
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
    const c = requireComposed();
    c.logger.warn('data.deleteEverything invoked — full nuke for this user');

    if (c.orchestrator.state === 'recording') {
      c.orchestrator.stop('user_wipe');
    }
    await c.uploadQueue.stop();
    c.jobStore.wipeAll();
    const recDir = path.join(c.userDataDir, 'recordings');
    try {
      fs.rmSync(recDir, { recursive: true, force: true });
      fs.mkdirSync(recDir, { recursive: true, mode: 0o700 });
    } catch (e) {
      c.logger.error('failed to clear recordings dir', { err: String(e) });
    }
    c.uploadQueue.start();
    c.analytics.track('data_deleted', {});
    return {};
  });

  // Legacy-data import — placeholder until step 7 wires the actual file move.
  b.handle(REQUEST.STORAGE_IMPORT_LEGACY, () => {
    return { imported: false, sessionsImported: 0 };
  });
}

// ─── Hotkey + globe-key (per-user, but the platform manager lives on shell) ──

function isFnOnlyHotkey(h: Hotkey): boolean {
  return h.modifiers.length === 1 && h.modifiers[0] === 'Fn' && h.key === null;
}

function ensureFnFreedIfHotkeyIsFn(
  hotkey: Hotkey | null,
  logger: Shell['logger'],
): void {
  if (process.platform !== 'darwin') return;
  if (hotkey !== null && !isFnOnlyHotkey(hotkey)) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const native = require('@twinmind/coreaudio-darwin') as {
      fnUsageType?: () => { get(): number | null; set(value: number): boolean };
    };
    const fn = native.fnUsageType?.();
    if (!fn) return;
    const current = fn.get();
    if (current === 0) return;
    const ok = fn.set(0);
    logger.info('fn-usage-type set to 0 (Do Nothing)', { previous: current, ok });
  } catch (err) {
    logger.warn('fn-usage-type set skipped (native helper unavailable)', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function registerPrimaryHotkey(c: ComposedApp, hotkey: Hotkey): () => void {
  let primaryHoldStarted = false;
  // The hotkey is dictation-only. Hold-to-talk is the original short-form
  // gesture; double-tap starts a CONSTANT dictation (runs until single-tap
  // stops it). Meeting mode is no longer reachable from the hotkey — the
  // floating "Take notes" button on the HUD is the only entry point.
  const gesture = new HotkeyGestureRecognizer({
    onHoldStart: () => {
      if (
        c.orchestrator.state === 'idle' &&
        !composedBindings?.transcriptionUx.isBlockingNewRecording()
      ) {
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
      if (
        c.orchestrator.state === 'idle' &&
        !composedBindings?.transcriptionUx.isBlockingNewRecording()
      ) {
        c.orchestrator.startDictation();
        hud?.revealOnActiveDisplay();
      }
    },
    onSingleTap: () => {
      // Stop ONLY constant dictation (i.e. the kind started by double-tap or
      // by the main pill). Single-tap during a meeting is a no-op — meetings
      // must be stopped from the meeting button.
      if (c.orchestrator.state === 'recording' && c.orchestrator.snapshot().mode === 'dictation') {
        c.orchestrator.stop('user');
      }
    },
  });
  return c.platform.hotkeys.registerPressRelease({
    hotkey,
    onPress: () => {
      if (!onboardingComplete) return;
      gesture.press();
    },
    onRelease: () => {
      if (!onboardingComplete) return;
      gesture.release();
    },
  });
}

// ─── Compose-bindings lifecycle ─────────────────────────────────────────────

function attachComposedBindings(c: ComposedApp, s: Shell): ComposedBindings {
  // ─── TranscriptionUx ─────────────────────────────────────────────────────
  const transcriptionUx = new TranscriptionUx({
    store: c.jobStore,
    notifications: s.platform.notifications,
    broadcastToHud: (state) => {
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
    // Called once every chunk of the session has reached a terminal state.
    // Two jobs:
    //   1) Fire the meeting-summary call (no-op for dictation sessions).
    //   2) For dictation sessions, paste the FULL accumulated transcript
    //      once — V1's behavior. We don't paste per-chunk because
    //      mid-session pastes collide with the HUD's device-picker UI
    //      (Cmd-V eaten by the open dropdown) and with any other moment
    //      the user is interacting with the HUD. Pasting once at session
    //      end avoids the whole class of focus-timing bugs.
    onSessionProcessed: (sessionId) => {
      void fireSummary(sessionId);
      const session = c.jobStore.getSession(sessionId);
      if (session?.mode !== 'dictation') return;
      const detail = c.jobStore.getSessionWithTranscripts(sessionId);
      if (!detail) return;
      // Transcripts come back in chunk-idx order. Drop empties (VAD-skipped
      // chunks have text=''), join with spaces, paste once. The user sees
      // the same text appear that the Sessions tab also shows.
      const text = detail.transcripts
        .map((t) => t.text.trim())
        .filter((t) => t.length > 0)
        .join(' ');
      if (text.length > 0) {
        void s.platform.paste.paste(text);
      }
    },
  });

  // ─── Primary hotkey ──────────────────────────────────────────────────────
  const primary = c.settings.load().settings.hotkeys.primary;
  const primaryUnreg =
    primary && !isFnOnlyHotkey(primary) ? registerPrimaryHotkey(c, primary) : null;
  ensureFnFreedIfHotkeyIsFn(primary, s.logger);

  // ─── Globe (Fn) key ──────────────────────────────────────────────────────
  let globeKeyDispose: (() => void) | null = null;
  if (s.platform.globeKey) {
    const globe = s.platform.globeKey;
    let globeHoldStarted = false;
    const globeGesture = new HotkeyGestureRecognizer({
      onHoldStart: () => {
        if (
          c.orchestrator.state === 'idle' &&
          !transcriptionUx.isBlockingNewRecording()
        ) {
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
        // Globe-key is dictation-only, same rules as the configurable
        // primary hotkey above. Meeting mode is only reachable via the
        // floating "Take notes" button on the HUD.
        if (
          c.orchestrator.state === 'idle' &&
          !transcriptionUx.isBlockingNewRecording()
        ) {
          c.orchestrator.startDictation();
          hud?.revealOnActiveDisplay();
        }
      },
      onSingleTap: () => {
        if (c.orchestrator.state === 'recording' && c.orchestrator.snapshot().mode === 'dictation') {
          c.orchestrator.stop('user');
        }
      },
    });
    globe.start();
    const globeSuppressed = () => primary !== null && !isFnOnlyHotkey(primary);
    globe.onPress(() => {
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
    globeKeyDispose = () => globe.stop();
  }

  // ─── Power monitor ───────────────────────────────────────────────────────
  const power = new PowerMonitorAdapter({
    powerMonitor,
    orchestrator: c.orchestrator,
    store: c.jobStore,
    logger: c.logger,
  });
  power.onResumePrompt((e) => {
    s.platform.notifications.show(
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
          c.orchestrator.startMeeting({ title: `Resumed from ${e.sessionId.slice(0, 8)}` });
          hud?.revealOnActiveDisplay();
        }
      },
    );
  });

  // ─── Meeting auto-detection ──────────────────────────────────────────────
  if (c.meetingDetection) {
    c.meetingDetection.onMeetingDetected((evt) => {
      c.analytics.track('meeting_notification_shown', { trigger: 'mic_activity' });
      const cfg = c.settings.load().settings;
      if (cfg.meetingDetection.autoStart) {
        c.orchestrator.startMeeting();
        c.meetingDetection?.recordOutcome(evt.promptId, 'accepted');
        c.analytics.track('meeting_notification_outcome', { action: 'accepted' });
        hud?.revealOnActiveDisplay();
        return;
      }
      s.platform.notifications.show(
        {
          title: 'Recording detected',
          body: 'Start a meeting note?',
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

  // ─── Device-lost broadcast ───────────────────────────────────────────────
  c.orchestrator.onDeviceLost(({ sessionId, mode, reason }) => {
    let devices: ReadonlyArray<{
      id: string;
      name: string;
      isDefault: boolean;
      kind: 'built_in' | 'bluetooth' | 'usb' | 'other';
    }> = [];
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const native = require('@twinmind/coreaudio-darwin') as {
        listInputDevices?: () => typeof devices;
      };
      devices = typeof native.listInputDevices === 'function' ? native.listInputDevices() : [];
    } catch {
      /* native not loaded */
    }
    if (!bridge) return;
    const payload = {
      sessionId,
      mode,
      lastDeviceLabel: null,
      reason,
      devices,
    };
    if (hud) {
      try {
        bridge.broadcast(hud.webContents(), PUSH.MIC_DEVICE_LOST, payload);
      } catch {
        /* HUD torn down */
      }
    }
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        bridge.broadcast(win.webContents, PUSH.MIC_DEVICE_LOST, payload);
      } catch {
        /* renderer torn down */
      }
    }
  });

  // ─── Upload queue listeners ──────────────────────────────────────────────
  const onChunkCompleted = (e: {
    sessionId: string;
    chunkId: string;
    segment: { text: string };
  }) => {
    transcriptionUx.onChunkCompleted(e.chunkId);
    if (e.segment.text.trim() === '') return;
    const chunk = c.jobStore.getChunk(e.chunkId);
    if (!chunk) return;
    // NB: dictation auto-paste happens once at session-end via
    // TranscriptionUx.onSessionProcessed, NOT here. Per-chunk paste broke
    // for multi-chunk dictation (device-loss resume, long constant
    // dictation) because mid-session Cmd-V races the HUD's device-picker
    // dropdown and lands nowhere visible.
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
          /* renderer gone */
        }
      }
      if (hud) {
        try {
          bridge.broadcast(hud.webContents(), PUSH.TRANSCRIPT_SEGMENT, payload);
        } catch {
          /* HUD gone */
        }
      }
    }
  };
  const onChunkFailedPermanent = (e: { chunkId: string; errorClass: string }) => {
    transcriptionUx.onChunkFailedPermanent(e.chunkId, e.errorClass);
  };
  c.uploadQueue.on('chunk_completed', onChunkCompleted);
  c.uploadQueue.on('chunk_failed_permanent', onChunkFailedPermanent);

  // ─── Orchestrator state listener (broadcasts recording state) ────────────
  let prevSnap: { sessionId: string | null; elapsedMs: number } | null = null;
  const stateListener = (snap: { sessionId: string | null; elapsedMs: number }) => {
    if (bridge && composed) broadcastRecordingState(bridge, composed);
    if (prevSnap?.sessionId && snap.sessionId === null) {
      transcriptionUx.onRecordingStopped(prevSnap.sessionId, prevSnap.elapsedMs);
    }
    prevSnap = { sessionId: snap.sessionId, elapsedMs: snap.elapsedMs };
  };
  c.orchestrator.on('state_changed', stateListener);

  return {
    transcriptionUx,
    primaryHotkey: primary,
    primaryHotkeyUnregister: primaryUnreg,
    globeKeyDispose,
    powerDispose: () => power.destroy(),
    // orchestrator + uploadQueue listeners die with the composed app:
    // composed.shutdown() stops the queue (drains in-flight + halts dispatch)
    // and the orchestrator becomes inert once its store is closed. We don't
    // remove the listeners explicitly because the underlying EventEmitter
    // shapes don't expose `off` — and the references are GC'd with composed.
    orchestratorStateDispose: () => {
      /* tied to composed.shutdown */
      void stateListener;
    },
    uploadQueueDispose: () => {
      /* tied to composed.shutdown */
      void onChunkCompleted;
      void onChunkFailedPermanent;
    },
  };
}

function detachComposedBindings(b: ComposedBindings): void {
  b.primaryHotkeyUnregister?.();
  b.globeKeyDispose?.();
  b.powerDispose();
  b.orchestratorStateDispose();
  b.uploadQueueDispose();
}

/**
 * Tear down the current composed (if any) and start a fresh one for `userId`.
 * Used both at startup (if already authenticated) and on auth-state changes.
 */
async function swapComposedTo(userId: string | null): Promise<void> {
  const s = requireShell();
  if (composedBindings) {
    detachComposedBindings(composedBindings);
    composedBindings = null;
  }
  if (composed) {
    try {
      await composed.shutdown();
    } catch (err) {
      s.logger.warn('composed shutdown threw', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    composed = null;
  }
  if (userId !== null) {
    composed = s.composeForUser(userId);
    composedBindings = attachComposedBindings(composed, s);
    if (composed.meetingDetection) {
      micMonitorStatus.serviceStarted = true;
      micMonitorStatus.serviceStartedAt = Date.now();
      composed.logger.info('meeting_detection_service_started');
    }
    // Post-recovery: any meeting that ended with transcripts but no summary
    // (crash mid-summary, or crash before summary ever fired) auto-fires
    // now so the user doesn't have to click Generate summary manually.
    // fireSummary is idempotent. The upload queue's onSessionProcessed
    // hook covers the case where orphan chunks need to transcribe first —
    // summary fires automatically when their state reaches `completed`.
    //
    // Run sequentially with `await` (not `void` / parallel) — if recovery
    // finds 10+ candidates, a parallel burst would slam the summary
    // endpoint and starve the user's main-thread network bandwidth on
    // startup. Each fireSummary is fast when it's a no-op (the guards
    // short-circuit) and slow only when a real network call happens,
    // so serial is the right pace.
    const candidates = composed.jobStore.findMeetingsNeedingSummary();
    if (candidates.length > 0) {
      composed.logger.info('post-recovery auto-summary queued', {
        count: candidates.length,
      });
      void (async () => {
        for (const session of candidates) {
          await fireSummary(session.id);
        }
      })();
    }
  }
}

// ─── Broadcast helpers ──────────────────────────────────────────────────────

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
      /* renderer gone */
    }
  }
}

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

function broadcastSummaryState(
  sessionId: string,
  status: 'pending' | 'completed' | 'failed',
  summaryId?: string,
  title?: string,
): void {
  if (!bridge) return;
  const payload: { sessionId: string; status: typeof status; summaryId?: string; title?: string } =
    { sessionId, status };
  if (summaryId) payload.summaryId = summaryId;
  if (title) payload.title = title;
  const targets: WebContents[] = [];
  if (hud) targets.push(hud.webContents());
  for (const w of BrowserWindow.getAllWindows()) targets.push(w.webContents);
  for (const wc of targets) {
    try {
      bridge.broadcast(wc, PUSH.SUMMARY_STATE_CHANGED, payload);
    } catch {
      /* renderer gone */
    }
  }
}

/**
 * Fire a per-meeting summary call. Idempotent: skips when the session
 * doesn't exist, isn't a meeting, has no end time, or is already pending /
 * completed. Used by both the auto-trigger (after all chunks land) and the
 * SESSION_RETRY_SUMMARY IPC.
 */
async function fireSummary(sessionId: string): Promise<void> {
  if (!composed || !shell) return;
  const logger = shell.logger;
  const session = composed.jobStore.getSession(sessionId);
  if (!session) {
    logger.info('summary skipped', { sessionId, reason: 'session_missing' });
    return;
  }
  if (session.mode !== 'meeting') {
    logger.info('summary skipped', { sessionId, reason: 'not_meeting' });
    return;
  }
  if (session.ended_at == null) {
    logger.info('summary skipped', { sessionId, reason: 'not_ended' });
    return;
  }
  if (session.summary_status === 'completed') {
    logger.info('summary skipped', { sessionId, reason: 'already_completed' });
    return;
  }
  if (session.summary_status === 'pending') {
    logger.info('summary skipped', { sessionId, reason: 'already_pending' });
    return;
  }
  // Defer when chunks are still uploading — summarizing now would give a
  // partial transcript. The onSessionProcessed hook will re-fire summary
  // once the last chunk reaches a terminal state.
  if (composed.jobStore.sessionHasInFlightChunks(sessionId)) {
    logger.info('summary skipped', { sessionId, reason: 'chunks_in_flight' });
    return;
  }
  // Don't fire when there's no transcript text. Distinct from "has any
  // completed chunk" — VAD-skipped chunks reach state=completed with
  // text=''. Without this check, an all-silent meeting POSTs an empty
  // body and the backend LLM call 500s.
  if (!composed.jobStore.sessionHasTranscribedText(sessionId)) {
    logger.info('summary skipped', { sessionId, reason: 'no_transcript_text' });
    return;
  }

  composed.jobStore.setSummaryPending(sessionId, Date.now());
  broadcastSummaryState(sessionId, 'pending');

  try {
    const result = await composed.summaryClient.requestSummary({
      sessionId,
      startedAt: session.started_at,
      endedAt: session.ended_at,
    });
    composed.jobStore.setSummaryCompleted(sessionId, result.summaryId, Date.now());

    // Apply the backend-suggested title only when the session has no title
    // yet — once the user has edited it, we never overwrite. Re-read the
    // session row (not the cached `session` variable above) because the
    // user might have set a title while the summary call was in flight.
    let appliedTitle: string | undefined;
    if (result.title && result.title.trim().length > 0) {
      const current = composed.jobStore.getSession(sessionId);
      if (current && current.title === null) {
        const cleaned = result.title.trim();
        composed.jobStore.updateSessionTitle(sessionId, cleaned);
        appliedTitle = cleaned;
      }
    }
    broadcastSummaryState(sessionId, 'completed', result.summaryId, appliedTitle);
  } catch (err) {
    composed.jobStore.setSummaryFailed(sessionId);
    shell.logger.warn('summary request failed', {
      sessionId,
      message: err instanceof Error ? err.message : String(err),
    });
    broadcastSummaryState(sessionId, 'failed');
  }
}

function broadcastAuthState(): void {
  if (!bridge || !shell) return;
  const payload = shell.authProvider.getViewState();
  const targets: WebContents[] = [];
  if (hud) targets.push(hud.webContents());
  for (const w of BrowserWindow.getAllWindows()) targets.push(w.webContents);
  for (const wc of targets) {
    try {
      bridge.broadcast(wc, PUSH.AUTH_STATE_CHANGED, payload);
    } catch {
      /* renderer gone */
    }
  }
}

// ─── System-audio probe (unchanged from previous main.ts) ──────────────────

async function probeSystemAudio(logger: Shell['logger']): Promise<boolean> {
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

// ─── App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // 1. audio-process + platform
  const spawned = spawnAudioProcess();
  audioProcessHandle = spawned.child;
  audioPort = spawned.port;
  const audioLink = makeAudioLink(audioPort);
  const platform = buildPlatformServices();

  // Surface audio-process events.
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
      if (hud && bridge) {
        try {
          bridge.broadcast(hud.webContents(), PUSH.AMPLITUDE_SAMPLE, {
            value: msg.value,
            audioClockMs: msg.audioClockMs,
          });
        } catch {
          /* HUD gone */
        }
      }
      return;
    }
    if (msg.type === 'chunk_closed') {
      const chunk = composed?.jobStore.getChunk(msg.chunkId);
      if (chunk && composedBindings) {
        composedBindings.transcriptionUx.onChunkPersisted(chunk.session_id);
      }
    }
    if (msg.type === 'mic_rebound') {
      if (!shell) return;
      shell.platform.notifications.show(
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

  // 2. Build the shell.
  shell = buildShell({ audioLink, platform, appVersion: app.getVersion() });
  shell.platform.deviceMonitor.start();

  // If a twinmind:// link was clicked before the shell finished initializing
  // (cold-launch via deep link), drain it now so the in-flight signIn picks
  // it up. A no-op if signIn() isn't waiting — the provider just logs it.
  if (pendingAuthCallbackUrl) {
    shell.authProvider.deliverAuthCallback(pendingAuthCallbackUrl);
    pendingAuthCallbackUrl = null;
  }

  // 3. IPC bridge.
  bridge = new IpcBridgeMain(ipcMain, shell.logger);
  wireIpc(bridge);

  // 4. Initialize auth + subscribe to state changes.
  await shell.authProvider.initialize();
  shell.authProvider.onAuthChange(async () => {
    const userId = shell!.authProvider.getState().userId;
    try {
      await swapComposedTo(userId);
    } catch (err) {
      shell!.logger.error('swapComposedTo failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    broadcastAuthState();
  });

  // 5. Seed onboardingComplete from globalDb.
  onboardingComplete = shell.globalDb.getOnboardingCompletedAt() !== null;

  // 6. If already authenticated (rehydrated from globalDb), compose now.
  const initialUserId = shell.authProvider.getState().userId;
  if (initialUserId !== null) {
    try {
      await swapComposedTo(initialUserId);
    } catch (err) {
      shell.logger.error('initial composeForUser failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 7. Create the HUD + main window + tray. HUD honors `onboardingComplete`.
  hud = new FloatingHudWindow(
    PRELOAD_PATH,
    HUD_HTML,
    process.env.NODE_ENV === 'development' ? HUD_DEV_URL : undefined,
    onboardingComplete,
  );
  mainWindow = createMainWindow();
  tray = new TrayManager({ onOpenHome: () => openHome(), logger: shell.logger });
  tray.init();

  // 8. Broadcast initial auth state once the renderer can subscribe.
  if (mainWindow) {
    mainWindow.webContents.once('did-finish-load', () => broadcastAuthState());
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event) => {
  if (!shell) return;
  event.preventDefault();
  tray?.destroy();
  hud?.destroy();
  if (composedBindings) {
    detachComposedBindings(composedBindings);
    composedBindings = null;
  }
  if (composed) {
    try {
      await composed.shutdown();
    } catch {
      /* best-effort */
    }
    composed = null;
  }
  await shell.shutdown();
  shell = null;
  audioProcessHandle?.kill();
  app.exit(0);
});

app.on('activate', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
    return;
  }
  if (!mainWindow.isVisible()) {
    showMainWindowOnCurrentSpace(mainWindow);
  }
});
