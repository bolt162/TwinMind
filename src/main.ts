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
import { AccessibilityWatcher } from '@platform/darwin/AccessibilityWatcher';
import type { IMicActivityMonitor } from '@platform/IMicActivityMonitor';
import type { IGlobeKeyManager } from '@platform/IGlobeKeyManager';
import { hotkeysEqual, type Hotkey } from '@core/hotkey/HotkeyTypes';
import { UpdateService } from '@core/update/UpdateService';

// userData folder. Set explicitly (rather than letting Electron derive from
// productName) so it stays "TwinMind" across product renames and is easy to
// reason about for support / log spelunking. Path:
//   macOS:   ~/Library/Application Support/TwinMind
//   Linux:   ~/.config/TwinMind          (if/when supported)
//   Windows: %APPDATA%/TwinMind          (if/when supported)
//
// Pre-1.0 (versions 2.0.0-pre.x) wrote to `TwinMind-V2/`. We do a one-shot
// rename here for any existing internal-tester / developer install that has
// data in the legacy folder: if the new folder doesn't exist yet AND the
// legacy folder does, atomically rename. Idempotent on subsequent launches
// (the legacy folder is gone after the first successful rename). Failure
// here is non-fatal — we fall through to setPath, which creates a fresh
// `TwinMind/`; the legacy data stays put on disk for manual recovery if
// the user notices.
const USERDATA_DIRNAME = 'TwinMind';
const LEGACY_USERDATA_DIRNAME = 'TwinMind-V2';
{
  // E2E override: each spec passes a tmpdir via TWINMIND_USER_DATA_DIR so
  // runs don't share DB / Keychain state with the user's real install.
  const override = process.env.TWINMIND_USER_DATA_DIR;
  if (override) {
    fs.mkdirSync(override, { recursive: true });
    app.setPath('userData', override);
  } else {
    const appData = app.getPath('appData');
    const newPath = path.join(appData, USERDATA_DIRNAME);
    const legacyPath = path.join(appData, LEGACY_USERDATA_DIRNAME);
    try {
      if (fs.existsSync(legacyPath) && !fs.existsSync(newPath)) {
        fs.renameSync(legacyPath, newPath);
      }
    } catch {
      // best-effort; setPath below still works against whatever's there
    }
    app.setPath('userData', newPath);
  }
}

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
  // Bring TwinMind back to the foreground. The OAuth round-trip handed
  // focus to the system browser; without these the app stays behind and
  // the user has to click the dock icon (or our window in the background)
  // themselves to see the post-sign-in state. `app.focus({ steal: true })`
  // is the canonical Electron pattern for "OAuth handoff complete, claim
  // foreground from the browser" — plain `.focus()` only raises within
  // our own app, not from another foreground app.
  if (process.platform === 'darwin') app.focus({ steal: true });
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    showMainWindowOnCurrentSpace(mainWindow);
    mainWindow.focus();
  }
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
let updateService: UpdateService | null = null;
/**
 * Watches macOS Accessibility trust for transitions while the app is running.
 * On revoke: proactively stop the Globe-key CGEventTap and uiohook (also a
 * CGEventTap) before either can wedge under an untrusted process, then push
 * a banner. On re-grant: restart both and dismiss the banner. Constructed in
 * app.whenReady, disposed in before-quit.
 */
let accessibilityWatcher: AccessibilityWatcher | null = null;

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

/**
 * Age threshold (ms) for the sibling sweep in `onChunkCompleted` that
 * unsticks 'uploading' chunks orphaned by a previous crash. Must be >=
 * the upload-fetch timeout (30 s in TwinMindAsrClient today) so we
 * never race a still-in-flight live upload.
 */
const STUCK_UPLOADING_RECOVER_THRESHOLD_MS = 30_000;

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
  /** Removes the orchestrator's chunk_persisted listener that drains the HUD. */
  readonly chunkPersistedDispose: () => void;
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
  // E2E mode swaps OS-touching services for in-memory fakes so the renderer
  // and orchestrator paths run unchanged, but Playwright can fully drive
  // them. macOS TCC prompts + paste keystrokes can't be automated otherwise.
  const isE2E = process.env.TWINMIND_E2E === '1';
  const permissions = isE2E
    ? (() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { FakePermissionService } = require('@platform/test/FakePermissionService') as typeof import('@platform/test/FakePermissionService');
        return new FakePermissionService({
          mic: 'granted',
          audioCapture: 'granted',
          accessibility: 'granted',
          notifications: 'granted',
        });
      })()
    : new DarwinPermissionService();
  const paste = isE2E
    ? (() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { FakePasteService } = require('@platform/test/FakePasteService') as typeof import('@platform/test/FakePasteService');
        return new FakePasteService();
      })()
    : new DarwinPasteService();
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

/**
 * Gate every recording-start call site behind this. Reads the macOS mic
 * grant; if anything other than `granted` (denied, not_determined,
 * unavailable) we broadcast `MIC_PERMISSION_REQUIRED` to the HUD + every
 * renderer so the HUD shows the "Please grant Microphone permission"
 * banner, and return false so the caller short-circuits without invoking
 * the orchestrator. Returns true only when the OS has actually granted —
 * we deliberately do NOT implicitly call `permissions.request('mic')`
 * here even on `not_determined`; the banner surfaces the requirement
 * instead of firing the native prompt under the user.
 */
function ensureMicGrantedOrBanner(mode: 'dictation' | 'meeting'): boolean {
  const grant = requireShell().platform.permissions.read('mic');
  if (grant === 'granted') return true;
  if (!bridge) return false;
  const targets: WebContents[] = [];
  if (hud) targets.push(hud.webContents());
  for (const w of BrowserWindow.getAllWindows()) targets.push(w.webContents);
  // `grant` here is one of: 'denied' | 'not_determined' | 'unavailable'
  // (granted was returned above). The HUD picks the right primary action
  // based on this — see `MicPermissionBanner` in HudApp.tsx and the
  // MicPermissionRequired payload doc in channels.ts.
  for (const wc of targets) {
    try {
      bridge.broadcast(wc, PUSH.MIC_PERMISSION_REQUIRED, { mode, grant });
    } catch {
      /* renderer torn down */
    }
  }
  return false;
}

function wireIpc(b: IpcBridgeMain): void {
  // ── Auth (always available — touches shell) ──────────────────────────────
  b.handle(REQUEST.AUTH_GET_STATE, () => requireShell().authProvider.getViewState());
  b.handle(REQUEST.AUTH_SIGN_IN, async () => {
    const r = await requireShell().authProvider.signIn();
    if (!r.ok) {
      // Surface sign-in failures (network, cancelled, config_missing, …)
      // to analytics. Done at the IPC boundary instead of inside the
      // provider so we don't have to inject analytics into the auth code.
      requireShell().analytics.track('error_occurred', {
        type: 'auth_sign_in',
        error: r.error ?? 'unknown',
        message: r.message ? r.message.slice(0, 200) : null,
      });
    }
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

  // ── Update (always available — UpdateService is shell-scoped) ────────────
  // Disabled in dev / non-darwin — the service short-circuits internally and
  // returns a `disabled: true` state snapshot, so handlers below never have
  // to special-case that path.
  b.handle(REQUEST.UPDATE_GET_STATE, () => {
    if (!updateService) {
      // Shell not yet built — return a synthetic disabled snapshot. The
      // renderer subscribes to UPDATE_STATE_CHANGED for the real one.
      return {
        phase: 'idle' as const,
        version: null,
        progressPercent: null,
        error: null,
        disabled: true,
        currentVersion: app.getVersion(),
      };
    }
    return updateService.getState();
  });
  b.handle(REQUEST.UPDATE_CHECK_NOW, () => {
    updateService?.checkNow();
    return {};
  });
  b.handle(REQUEST.UPDATE_QUIT_AND_INSTALL, () => {
    if (!updateService) return { ok: false, error: 'not_ready' as const };
    const r = updateService.quitAndInstall();
    return r.error ? { ok: r.ok, error: r.error } : { ok: r.ok };
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
    granted: (await requireShell().platform.permissions.request('audioCapture')) === 'granted',
  }));
  b.handle(REQUEST.PERMISSIONS_REQUEST_ACCESSIBILITY, async () => {
    const grant = await requireShell().platform.permissions.request('accessibility');
    return { granted: grant === 'granted' };
  });
  b.handle(REQUEST.PERMISSIONS_REQUEST_NOTIFICATIONS, async () => {
    // Prompt through Electron's own Notification API — NOT a native
    // UNUserNotificationCenter.requestAuthorization call. Electron must remain
    // the sole owner of the notification center: it sets the delegate that
    // lets banners present while the app is in the foreground. A second,
    // independent UNUserNotificationCenter consumer in the native addon
    // displaced that ownership and silently suppressed all meeting banners.
    // Showing an Electron notification triggers the OS authorization prompt the
    // first time (when not_determined) and registers Electron's delegate. The
    // live status pill reads the real grant separately (read-only path).
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
      const s = requireShell();
      syncFnUsageForHotkey(nextHotkey, { globalDb: s.globalDb, logger: s.logger });
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
          hasText: s.has_text === 1,
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
      hasText: r.transcripts.some((t) => t.text.trim().length > 0),
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
  b.handle(REQUEST.MAIN_OPEN_WEB_APP, async () => {
    // URL resolved server-side from the same config that drives the
    // per-meeting "View Summary" deep link (main.ts:733). Renderer never
    // sees a URL it could spoof. Defaults to `https://app.twinmind.com`;
    // overridable via `TWINMIND_APP_URL` env var (e.g., staging builds).
    const cfgRes = resolveTwinMindBackendConfig();
    if (!cfgRes.ok) throw new Error('Backend not configured');
    const { shell: electronShell } = await import('electron');
    await electronShell.openExternal(cfgRes.config.appUrl);
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
    if (!ensureMicGrantedOrBanner('dictation')) return {};
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
    // Meeting REQ's contract is `{ sessionId }`; if mic permission is
    // denied we still need to return a string, so throw — the renderer's
    // .catch(() => {}) swallows it and the broadcasted banner is what the
    // user actually sees.
    if (!ensureMicGrantedOrBanner('meeting')) {
      throw new Error('Microphone permission required');
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
  b.handle(REQUEST.REC_DICTATION_LIMIT_DISMISS, () => {
    // Fired by both the Dismiss and Dictate buttons on the HUD's 5-min
    // limit banner. Just clears the banner state; the Dictate button
    // separately invokes REC_START_DICTATION right after.
    composedBindings?.transcriptionUx.onDictationLimitDismissed();
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
  b.handle(REQUEST.HUD_SET_VISUAL_STATE, ({ visual }) => {
    hud?.setVisualState(visual);
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

/**
 * Sentinel persisted in `globalDb.kv['fn_usage_type_saved']` to mean "the OS
 * was already at 0 when we first looked, so we don't own that state and
 * have nothing to restore."
 */
const FN_USAGE_NOT_OWNED = '__none__';

/**
 * Lazy-load the native Fn-usage helper. Returns null on non-darwin, when
 * the addon is missing, or when the export is unavailable. All failure
 * modes are silent — best-effort, never a regression versus pre-helper.
 */
function loadFnUsageNative(logger: Shell['logger']): {
  get(): number | null;
  set(value: number): boolean;
} | null {
  if (process.platform !== 'darwin') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const native = require('@twinmind/coreaudio-darwin') as {
      fnUsageType?: () => { get(): number | null; set(value: number): boolean };
    };
    return native.fnUsageType?.() ?? null;
  } catch (err) {
    logger.warn('fn-usage-type native helper unavailable', {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Sync the macOS "Press 🌐 key to:" preference against the active hotkey.
 *
 *  - Target=Fn (hotkey is null OR Fn-only): record the user's current
 *    value (or a "not-owned" sentinel if it was already 0), then set 0.
 *  - Target=non-Fn: restore the previously saved value if we still own
 *    the state (OS still at 0). If the user changed it externally we
 *    silently relinquish ownership without overwriting.
 *
 * The saved value lives in GlobalDb.kv so a crash / force-kill / mid-
 * session quit still restores on next launch. Machine-scoped because the
 * OS preference is too.
 */
function syncFnUsageForHotkey(
  hotkey: Hotkey | null,
  deps: { globalDb: Shell['globalDb']; logger: Shell['logger'] },
): void {
  const fn = loadFnUsageNative(deps.logger);
  if (!fn) return;
  const target = hotkey === null || isFnOnlyHotkey(hotkey);
  const cur = fn.get();
  const saved = deps.globalDb.getFnUsageSaved();
  if (target) {
    if (cur === 0) {
      if (saved === null) deps.globalDb.setFnUsageSaved(FN_USAGE_NOT_OWNED);
      return;
    }
    // `cur` is either a non-zero number or null (key unset → OS behaves as the
    // emoji default). Only persist a real numeric value; for the unset case
    // record the not-owned sentinel instead of `String(null)` ("null"), which
    // later parseInt()s to NaN in restoreFnUsageIfOwned and silently skips the
    // restore. We still set 0 in both cases so the OS doesn't pop the panel.
    if (saved === null) {
      deps.globalDb.setFnUsageSaved(cur === null ? FN_USAGE_NOT_OWNED : String(cur));
    }
    const ok = fn.set(0);
    deps.logger.info('fn-usage-type set to 0 (Do Nothing)', { previous: cur, ok });
  } else {
    restoreFnUsageIfOwned(deps);
  }
}

/**
 * Restore the saved AppleFnUsageType value if we still own the OS state.
 *
 * Called when no Fn-driven hotkey is active: sign-out, app quit, and the
 * non-Fn branch of `syncFnUsageForHotkey`. Idempotent — repeated calls
 * after a successful restore are no-ops.
 */
function restoreFnUsageIfOwned(
  deps: { globalDb: Shell['globalDb']; logger: Shell['logger'] },
): void {
  const saved = deps.globalDb.getFnUsageSaved();
  if (saved === null) return;
  if (saved === FN_USAGE_NOT_OWNED) {
    deps.globalDb.clearFnUsageSaved();
    return;
  }
  const fn = loadFnUsageNative(deps.logger);
  if (!fn) {
    // Can't restore without the native helper — but also can't leave a
    // stale saved record around forever. Clear it; the worst case is the
    // OS keeps the value it has, which is exactly what the user would
    // see if we never wrote it in the first place.
    deps.globalDb.clearFnUsageSaved();
    return;
  }
  const cur = fn.get();
  if (cur === 0) {
    const previous = Number.parseInt(saved, 10);
    if (!Number.isNaN(previous)) {
      const ok = fn.set(previous);
      deps.logger.info('fn-usage-type restored', { restored: previous, ok });
    }
  }
  // If cur !== 0, the user changed the value externally — respect that
  // and drop our record. Either way, our ownership ends here.
  deps.globalDb.clearFnUsageSaved();
}

function registerPrimaryHotkey(c: ComposedApp, hotkey: Hotkey): () => void {
  let primaryHoldStarted = false;
  // The hotkey is dictation-only. Hold-to-talk is the original short-form
  // gesture; double-tap starts a CONSTANT dictation (runs until single-tap
  // stops it). Meeting mode is no longer reachable from the hotkey — the
  // floating "Capture notes" button on the HUD is the only entry point.
  const gesture = new HotkeyGestureRecognizer({
    onHoldStart: () => {
      if (
        c.orchestrator.state === 'idle' &&
        !composedBindings?.transcriptionUx.isBlockingNewRecording()
      ) {
        if (!ensureMicGrantedOrBanner('dictation')) return;
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
        if (!ensureMicGrantedOrBanner('dictation')) return;
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
        // We always write to clipboard FIRST (DarwinPasteService line 34),
        // then attempt the Cmd-V keystroke. When Accessibility is denied
        // (or the native paste fails for any other reason) we get back
        // `clipboardOnly: true` — the text is on the user's clipboard but
        // didn't paste into the active app. Surface a brief HUD toast so
        // the user knows the text is there and they should ⌘V manually.
        void s.platform.paste.paste(text).then((r) => {
          if (!r.clipboardOnly) return;
          if (!bridge || !hud) return;
          try {
            bridge.broadcast(hud.webContents(), PUSH.HUD_CLIPBOARD_TOAST, {});
          } catch {
            /* HUD torn down */
          }
        });
      }
    },
  });

  // ─── Primary hotkey ──────────────────────────────────────────────────────
  const primary = c.settings.load().settings.hotkeys.primary;
  const primaryUnreg =
    primary && !isFnOnlyHotkey(primary) ? registerPrimaryHotkey(c, primary) : null;
  syncFnUsageForHotkey(primary, { globalDb: s.globalDb, logger: s.logger });

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
          if (!ensureMicGrantedOrBanner('dictation')) return;
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
        // floating "Capture notes" button on the HUD.
        if (
          c.orchestrator.state === 'idle' &&
          !transcriptionUx.isBlockingNewRecording()
        ) {
          if (!ensureMicGrantedOrBanner('dictation')) return;
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
    // Suppress the Globe (Fn) gesture exactly when a NON-Fn primary hotkey is
    // active, so Fn and the custom hotkey aren't both live. Read the LIVE
    // hotkey from `composedBindings` (updated on every SETTINGS_SET) rather
    // than the `primary` captured at attach time — otherwise switching away
    // from Fn would leave Fn erroneously active (two hotkeys), and the value
    // would never reflect later changes within the session.
    const globeSuppressed = () => {
      const active = composedBindings?.primaryHotkey ?? null;
      return active !== null && !isFnOnlyHotkey(active);
    };
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
          if (!ensureMicGrantedOrBanner('meeting')) return;
          c.orchestrator.startMeeting({ title: `Resumed from ${e.sessionId.slice(0, 8)}` });
          hud?.revealOnActiveDisplay();
        }
      },
    );
  });

  // ─── Meeting auto-detection ──────────────────────────────────────────────
  if (c.meetingDetection) {
    c.meetingDetection.onMeetingDetected((evt) => {
      const cfg = c.settings.load().settings;
      // autoStart path: skip the notification, start recording silently.
      // Tracked via the existing outcome event, NOT 'meeting_notification_shown'
      // (which would lie — no notification was ever shown).
      if (cfg.meetingDetection.autoStart) {
        if (!ensureMicGrantedOrBanner('meeting')) return;
        c.orchestrator.startMeeting();
        c.meetingDetection?.recordOutcome(evt.promptId, 'accepted');
        c.analytics.track('meeting_notification_outcome', { action: 'accepted' });
        hud?.revealOnActiveDisplay();
        return;
      }
      // Normal path: try to show the notification. Wrap in try/catch because
      // the underlying `new Notification()` / `notification.show()` can throw
      // on macOS when the user has denied notification permission at the OS
      // level (DarwinPermissionService can't introspect that state — always
      // reports 'granted', see §investigation notes). Without this catch the
      // exception used to be swallowed silently inside the event-listener
      // callback, costing us every diagnostic signal we could've had.
      try {
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
              if (!ensureMicGrantedOrBanner('meeting')) return;
              c.orchestrator.startMeeting();
              hud?.revealOnActiveDisplay();
            }
          },
        );
        // Track AFTER show() returns without throwing — the event now
        // honestly reflects "the OS accepted our notification call". Earlier
        // versions fired this before show(), so the metric was useless for
        // diagnosing the "users don't see notifications" bug.
        c.analytics.track('meeting_notification_shown', { trigger: 'mic_activity' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Intentionally LOUD — the previous silent-swallow was the bug.
        s.logger.error('meeting_notification_show_failed', {
          promptId: evt.promptId,
          message: msg,
        });
        c.analytics.track('meeting_notification_failed', {
          // Trim defensively; error messages from native code can be long.
          message: msg.slice(0, 200),
        });
        // Deliberately do NOT call recordOutcome here — even though the
        // outcome no longer drives suppression, writing a fake outcome for
        // a notification the user never saw would muddle the diagnostic
        // activity log. The next mic-start cycle will simply retry.
      }
    });
  }

  // ─── Dictation 5-min cap → HUD banner ────────────────────────────────────
  // Orchestrator fires this when its setTimeout(DICTATION_HARD_CAP_MS)
  // expires. We just route the sessionId into TranscriptionUx; that
  // state-machine flip pushes TRANSCRIPTION_UI_STATE to the HUD which
  // renders the DictationLimitBanner.
  c.orchestrator.onDictationLimitReached(({ sessionId }) => {
    transcriptionUx.onDictationLimitReached(sessionId);
  });

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
    // Auto-fire summary on every chunk completion. fireSummary is idempotent
    // (guards: already_pending, already_completed, chunks_in_flight,
    // no_transcript_text), so it only does work on the last in-flight chunk
    // — same effective semantics as TranscriptionUx.onSessionProcessed.
    //
    // Why this is needed in addition to onSessionProcessed: that path only
    // fires for sessions in `processingSessions`, which is populated only by
    // the live-recording stop path. Crash-recovered sessions — whose orphan
    // PCM was re-encoded on launch and whose chunks transcribe AFTER startup
    // — never enter processingSessions, so before this hook, their summary
    // never fired automatically (had to be clicked manually). The
    // post-recovery startup scan in swapComposedTo only catches sessions
    // whose transcripts already exist; recovered-then-transcribed needs
    // this per-chunk hook to land.
    void fireSummary(e.sessionId);

    // Sibling sweep: if this chunk's session has any sibling chunks stuck
    // in 'uploading' (orphaned by an earlier in-process crash mid-upload),
    // reset them to 'captured' so the upload queue picks them up. Gated
    // to non-active sessions and chunks older than the upload-fetch
    // timeout (30 s) so we never race a live upload.
    //
    // Why this is needed despite startup recovery already resetting all
    // 'uploading' rows: the user may keep the app running for hours
    // between launches. Without this hook, a crash-recovered session
    // whose orphan chunk completes successfully would still leave the
    // sibling stuck-uploading chunk perma-blocking summary until the
    // next app restart. This event-driven path closes that loop in
    // real time.
    try {
      const recovered = c.jobStore.resetStuckUploadingForEndedSession(
        e.sessionId,
        STUCK_UPLOADING_RECOVER_THRESHOLD_MS,
      );
      if (recovered > 0) {
        c.logger.info('reset stuck uploading siblings via chunk_completed', {
          sessionId: e.sessionId,
          count: recovered,
        });
      }
    } catch (err) {
      // Defensive — a sweep failure must not break the chunk_completed
      // pipeline (transcript broadcast, dictation paste, etc).
      c.logger.warn('sibling-sweep failed', {
        sessionId: e.sessionId,
        message: err instanceof Error ? err.message : String(err),
      });
    }

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

  // ─── Orchestrator chunk_persisted → drain HUD + broadcast VAD-skip ───────
  // Two jobs:
  //   1. Drain the HUD's processing set for VAD-skipped chunks (UploadQueue
  //      never fires chunk_completed for them since they bypass the upload
  //      path). Sourced from the orchestrator's post-closeChunk emission
  //      instead of from main's audioLink listener, which used to race the
  //      orchestrator and read the DB before the row existed.
  //   2. Broadcast TRANSCRIPT_SEGMENT for VAD-skipped chunks so SessionDetail
  //      / dictation tile views refetch and the chunk shows up immediately
  //      (with its empty transcript + HH:MM label). Voiced chunks are at
  //      state='captured' here — their broadcast fires later from
  //      onChunkCompleted with the actual text, so we deliberately skip
  //      them in this branch to avoid an empty-text segment racing the
  //      eventual transcript-carrying one.
  const chunkPersistedDispose = c.orchestrator.onChunkPersisted(({ sessionId, chunkId }) => {
    transcriptionUx.onChunkPersisted(sessionId);
    const chunk = c.jobStore.getChunk(chunkId);
    if (!chunk || chunk.state !== 'completed') return;
    // VAD-skipped chunk: empty payload triggers `useSession` / `useDictations`
    // to refetch — they just check `e.sessionId === sessionId` and reload,
    // they don't render the segment text directly.
    if (!bridge) return;
    const payload = {
      sessionId,
      chunkId,
      source: chunk.source,
      startMs: chunk.start_ms,
      endMs: chunk.end_ms,
      text: '',
    };
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        bridge.broadcast(win.webContents, PUSH.TRANSCRIPT_SEGMENT, payload);
      } catch {
        /* renderer gone */
      }
    }
  });

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
    chunkPersistedDispose,
  };
}

function detachComposedBindings(b: ComposedBindings): void {
  b.primaryHotkeyUnregister?.();
  b.globeKeyDispose?.();
  b.powerDispose();
  b.orchestratorStateDispose();
  b.uploadQueueDispose();
  b.chunkPersistedDispose();
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
  // NOTE: we intentionally do NOT restore AppleFnUsageType on sign-out. For a
  // user whose hotkey is Fn, flipping the OS preference back to "Show Emoji"
  // here (or on quit) is what re-poisons the per-app preference caches of
  // already-running apps on macOS: the OS caches AppleFnUsageType per app at
  // launch and doesn't reliably reload it, so a flip back to emoji sticks until
  // each app is relaunched. Keeping the value monotonic at 0 (set once, never
  // reset while Fn is the hotkey) is what makes Fn reliably suppress the emoji
  // panel. The user's prior value is still restored on the deliberate switch to
  // a non-Fn hotkey — see syncFnUsageForHotkey's non-Fn branch.
  if (userId !== null) {
    composed = await s.composeForUser(userId);
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
    const message = err instanceof Error ? err.message : String(err);
    shell.logger.warn('summary request failed', { sessionId, message });
    composed.analytics.track('error_occurred', {
      type: 'summary_request',
      sessionId,
      message: message.slice(0, 200),
    });
    broadcastSummaryState(sessionId, 'failed');
  }
}

/**
 * Broadcast the latest accessibility-grant state to every renderer. Called
 * by the AccessibilityWatcher on transitions; the HUD shows / clears a
 * banner so the user knows Fn + hotkeys won't work without Accessibility.
 */
function broadcastAccessibilityLost(granted: boolean): void {
  if (!bridge) return;
  const payload = { granted };
  const targets: WebContents[] = [];
  if (hud) targets.push(hud.webContents());
  for (const w of BrowserWindow.getAllWindows()) targets.push(w.webContents);
  for (const wc of targets) {
    try {
      bridge.broadcast(wc, PUSH.ACCESSIBILITY_LOST, payload);
    } catch {
      /* renderer gone */
    }
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

/**
 * Broadcast the latest update-service state to every renderer. Called both
 * from UpdateService's onStateChange callback and from did-finish-load on
 * the main window so a freshly-opened renderer can seed its UI without
 * waiting for the next transition.
 */
function broadcastUpdateState(): void {
  if (!bridge || !updateService) return;
  const payload = updateService.getState();
  const targets: WebContents[] = [];
  for (const w of BrowserWindow.getAllWindows()) targets.push(w.webContents);
  for (const wc of targets) {
    try {
      bridge.broadcast(wc, PUSH.UPDATE_STATE_CHANGED, payload);
    } catch {
      /* renderer gone */
    }
  }
}

/**
 * Wire `globalThis.__e2e` for Playwright specs. Only runs when
 * `TWINMIND_E2E=1`. Playwright drives the app via
 * `electronApp.evaluate(cb)` which executes `cb` inside main, so the hook
 * just needs to live on the main-process global.
 *
 * Intentionally avoids new IPC channels (no zod schemas to maintain, no risk
 * of a test channel slipping into prod) — everything routes through the
 * already-built shell / composed objects.
 */
function registerE2eHooksIfEnabled(): void {
  if (process.env.TWINMIND_E2E !== '1') return;
  if (!shell) return;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { FakePermissionService } = require('@platform/test/FakePermissionService') as typeof import('@platform/test/FakePermissionService');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { FakePasteService } = require('@platform/test/FakePasteService') as typeof import('@platform/test/FakePasteService');
  const perms = shell.platform.permissions as InstanceType<typeof FakePermissionService>;
  const paste = shell.platform.paste as InstanceType<typeof FakePasteService>;
  const g = globalThis as unknown as { __e2e?: unknown };
  g.__e2e = {
    permissions: perms,
    paste,
    getLastAuthBrowserUrl(): string | null {
      return (globalThis as unknown as { __e2eLastAuthBrowserUrl?: string | null })
        .__e2eLastAuthBrowserUrl ?? null;
    },
    clearLastAuthBrowserUrl(): void {
      (globalThis as unknown as { __e2eLastAuthBrowserUrl?: string | null })
        .__e2eLastAuthBrowserUrl = null;
    },
    deliverAuthCallback(url: string): void {
      routeAuthCallback(url);
    },
    /**
     * Mark onboarding as completed without driving the wizard UI. Used by
     * specs that care about post-wizard flows (Settings, recording) but not
     * about the wizard itself.
     */
    completeWizard(): void {
      if (!shell) throw new Error('completeWizard: shell not ready');
      shell.globalDb.setOnboardingCompletedAt(Date.now());
      onboardingComplete = true;
    },
    /**
     * Force the UpdateService into `ready` state so the renderer's
     * UpdateBanner mounts. e2e launches via `_electron.launch` are NOT
     * packaged (`app.isPackaged === false`), so the real
     * `electron-updater` path is `disabled` and never fires
     * `update-downloaded`. We reach into the service's private
     * `transition` (TypeScript-private; not enforced at runtime) and push
     * the state directly, then broadcast it through the existing IPC pipe
     * so renderers see it the same way they would in production.
     */
    forceUpdateReady(version: string): void {
      if (!updateService) throw new Error('forceUpdateReady: updateService not ready');
      (updateService as unknown as {
        transition: (p: {
          phase: string;
          version: string | null;
          progressPercent: number | null;
          error: null;
        }) => void;
      }).transition({
        phase: 'ready',
        version,
        progressPercent: null,
        error: null,
      });
      broadcastUpdateState();
    },
    diagnostics() {
      const authView = shell!.authProvider.getViewState();
      const orchSnap = composed?.orchestrator.snapshot() ?? {
        state: 'idle' as const,
        mode: 'idle' as const,
        sessionId: null,
        elapsedMs: 0,
      };
      return {
        auth: {
          isAuthenticated: authView.isAuthenticated,
          userId: authView.user?.id ?? null,
          userEmail: authView.user?.email ?? null,
        },
        orchestrator: {
          state: orchSnap.state,
          mode: orchSnap.mode,
          sessionId: orchSnap.sessionId,
        },
        permissions: perms.snapshot(),
        composedUserId: composed?.userId ?? null,
      };
    },
  };
  console.info('[main] e2e hooks registered (TWINMIND_E2E=1)');
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
    // NB: chunk_closed used to call transcriptionUx.onChunkPersisted from
    // here, but this listener registers BEFORE the orchestrator's audioLink
    // listener, so getChunk ran before ChunkWriter.closeChunk had inserted
    // the row — the notification was silently dropped. For VAD-skipped
    // chunks (which never fire chunk_completed via UploadQueue) that meant
    // the HUD waited the full PROCESSING_WATCHDOG_MS before draining. The
    // orchestrator now emits its own 'chunk_persisted' event AFTER
    // closeChunk's async write completes; main subscribes inside
    // attachComposedBindings (search 'chunkPersistedDispose').
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

  // Surface any native-addon load failure that happened in
  // buildPlatformServices (which runs before shell exists). Stored in
  // module-level micMonitorStatus and emitted now that analytics is
  // available. Fires once per launch when the addon couldn't load —
  // useful for spotting ABI mismatches and packaging regressions.
  if (micMonitorStatus.monitorLoadError) {
    shell.analytics.track('error_occurred', {
      type: 'native_addon_load',
      addon: 'mic_activity_monitor',
      message: micMonitorStatus.monitorLoadError.slice(0, 200),
    });
  }

  // 2a. Accessibility watcher. Polls TCC trust state every ~1.5s and reacts
  // to transitions. Critical for the system-freeze fix: when the user
  // revokes Accessibility mid-session, we proactively stop the Globe-key
  // CGEventTap and uiohook before either can wedge under an untrusted
  // process, then push a banner to the HUD. Re-grant restarts both
  // without an app restart. Darwin-only — the watcher is a no-op observer
  // on other platforms but constructing it is still safe.
  if (process.platform === 'darwin') {
    accessibilityWatcher = new AccessibilityWatcher();
    accessibilityWatcher.onChange((granted) => {
      if (!shell) return;
      shell.logger.info('accessibility grant changed', { granted });
      if (granted) {
        // Re-grant: restart the Globe tap (its internal AX precheck will
        // confirm trust before touching CGEventTapCreate) and re-arm
        // uiohook if any press/release bindings are still registered.
        try {
          shell.platform.globeKey?.start();
        } catch (err) {
          shell.logger.warn('globe-key restart after re-grant threw', {
            message: err instanceof Error ? err.message : String(err),
          });
        }
        try {
          (shell.platform.hotkeys as DarwinHotkeyManager).restartUio?.();
        } catch (err) {
          shell.logger.warn('uiohook restart after re-grant threw', {
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        // Revoke: stop both taps proactively. Native GlobeKey will also
        // self-heal via its tap_lost path when the OS fires the disabled
        // event, but stopping here closes the race where the user revokes
        // while no key is held (no events flowing → disabled callback may
        // not fire promptly).
        try {
          shell.platform.globeKey?.stop();
        } catch (err) {
          shell.logger.warn('globe-key stop on revoke threw', {
            message: err instanceof Error ? err.message : String(err),
          });
        }
        try {
          (shell.platform.hotkeys as DarwinHotkeyManager).stopUio?.();
        } catch (err) {
          shell.logger.warn('uiohook stop on revoke threw', {
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      broadcastAccessibilityLost(granted);
    });
    accessibilityWatcher.start();
  }

  // 2b. Auto-update service. Machine-scoped (no per-user state). Disabled
  // automatically in dev / non-darwin. The recording guard reads orchestrator
  // state through a closure — sign-out leaves `composed` null which the
  // closure treats as "not recording", which is correct.
  updateService = new UpdateService({
    logger: shell.logger,
    analytics: shell.analytics,
    appVersion: shell.appVersion,
    isRecording: () => {
      const s = composed?.orchestrator.state;
      return s === 'recording' || s === 'starting' || s === 'stopping';
    },
  });
  updateService.onStateChange(() => broadcastUpdateState());

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

  // E2E test hook: expose a `globalThis.__e2e` surface so Playwright specs
  // running outside the main process can drive permissions, OAuth callbacks,
  // and read diagnostics via `electronApp.evaluate(cb)`. No-op unless
  // TWINMIND_E2E=1. Lives next to the bridge so it has access to shell +
  // composed + platform fakes.
  registerE2eHooksIfEnabled();

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
    // Spec §6: update checks only run for authenticated users. Start the
    // scheduler when a user signs in; stop it on sign-out so we don't poll
    // the endpoint unauthenticated. Both calls are idempotent.
    if (userId !== null) {
      updateService?.startScheduler();
      // Tag every subsequent analytics event with this user_id. Pre-sign-in
      // events still flow with device_id only; the first post-identify event
      // lets Amplitude stitch anonymous activity into the user's profile.
      shell!.analytics.identify(userId);
    } else {
      updateService?.stopScheduler();
      // Note: we do NOT clear the cached user_id on sign-out (no clear API
      // on IAnalyticsClient). Events between sign-out and re-sign-in keep
      // the previous user_id; misattribution risk is small for most users.
    }
    broadcastAuthState();
  });

  // 5. Seed onboardingComplete from globalDb.
  onboardingComplete = shell.globalDb.getOnboardingCompletedAt() !== null;

  // 6. If already authenticated (rehydrated from globalDb), compose now.
  const initialUserId = shell.authProvider.getState().userId;
  if (initialUserId !== null) {
    // Identify BEFORE swapComposedTo so any analytics events emitted by the
    // per-user composition (recovery, queue startup) already carry user_id.
    // onAuthChange doesn't fire on rehydrate, so this is the only place
    // identify gets called for a session resumed from disk.
    shell.analytics.identify(initialUserId);
    try {
      await swapComposedTo(initialUserId);
    } catch (err) {
      shell.logger.error('initial composeForUser failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    // Same gate as the auth-change listener: start the update scheduler now
    // for the rehydrated session. onAuthChange doesn't fire on rehydrate.
    updateService.startScheduler();
  }

  // 7. Create the HUD + main window + tray. HUD honors `onboardingComplete`.
  hud = new FloatingHudWindow(
    PRELOAD_PATH,
    HUD_HTML,
    process.env.NODE_ENV === 'development' ? HUD_DEV_URL : undefined,
    onboardingComplete,
  );
  // Wire the edge-anchor pusher so the HUD can tell the renderer to flip
  // the hover-group expansion direction when the pill hugs a screen edge.
  // Push only to the HUD's own webContents — main window doesn't care.
  hud.setEdgeAnchorPusher((anchor) => {
    if (!bridge || !hud) return;
    try {
      bridge.broadcast(hud.webContents(), PUSH.HUD_EDGE_ANCHOR, anchor);
    } catch {
      /* HUD already torn down */
    }
  });
  // Seed the HUD with the current Accessibility-grant state once it can
  // subscribe. The watcher only emits on transitions, so without this push
  // a cold-launch with Accessibility already denied would leave the HUD
  // banner hidden until the user toggled the permission. Mirrors the
  // broadcastAuthState / broadcastUpdateState pattern below.
  hud.webContents().once('did-finish-load', () => {
    broadcastAccessibilityLost(accessibilityWatcher?.current() ?? true);
  });
  mainWindow = createMainWindow();
  tray = new TrayManager({ onOpenHome: () => openHome(), logger: shell.logger });
  tray.init();

  // 8. Broadcast initial auth + update state once the renderer can subscribe.
  if (mainWindow) {
    mainWindow.webContents.once('did-finish-load', () => {
      broadcastAuthState();
      broadcastUpdateState();
    });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event) => {
  if (!shell) return;
  event.preventDefault();
  // Fire app_quit BEFORE teardown so it's already in the queue when
  // shell.shutdown() awaits the flush below. reason='user' for v1 — we
  // don't yet distinguish updater-triggered quits from user-initiated.
  shell.analytics.track('app_quit', { reason: 'user' });
  tray?.destroy();
  hud?.destroy();
  accessibilityWatcher?.stop();
  accessibilityWatcher = null;
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
  // Tear down the update service BEFORE shell.shutdown() so its timers stop
  // firing during teardown. When this quit was triggered by quitAndInstall,
  // the squirrel installer is waiting for our process to exit — anything
  // that delays `app.exit(0)` below also delays the in-place swap.
  if (updateService) {
    try {
      await updateService.shutdown();
    } catch {
      /* best-effort */
    }
    updateService = null;
  }
  // We intentionally do NOT restore AppleFnUsageType on quit. Restoring the
  // user's prior "Show Emoji" here flips the OS preference back, and because
  // macOS caches it per app at launch (and doesn't reliably reload running
  // apps), the next launch's set-to-0 won't reach already-running apps — so the
  // emoji panel reappears until each app is relaunched. Keeping 0 monotonic
  // across quit/relaunch is what reliably suppresses the panel for Fn users.
  // The prior value is restored only on a deliberate switch to a non-Fn hotkey
  // (syncFnUsageForHotkey's non-Fn branch).
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
