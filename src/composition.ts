/**
 * Composition root — split into a machine-scoped Shell and a per-user ComposedApp.
 *
 * Architecture: multi-user isolation. The TwinMind backend identifies the
 * signed-in user; everything user-scoped (DB, recordings, transcripts, logs,
 * settings) lives at `<userData>/users/<slug>/`. Shell owns the things that
 * exist across user-switches: the audio-process link, platform services
 * (mic / hotkeys / Keychain), the global DB (user directory + wizard state),
 * the auth provider, the app-level logger, crash reporting, analytics.
 *
 * Lifecycle:
 *   1. `buildShell` is called once at startup from main.ts.
 *   2. `shell.composeForUser(userId)` builds a fresh per-user app when the
 *      auth provider reports a signed-in user. main.ts holds the result.
 *   3. On sign-out, main.ts calls `composedApp.shutdown()` (closes DB, stops
 *      queue, etc.). Shell stays alive.
 *   4. On a different user signing in, main.ts calls `composeForUser` again.
 *
 * The two-layer split is what gives multi-user isolation structural teeth:
 * a JobStore, ChunkWriter, UploadQueue, etc. are never reused across users —
 * they are reconstructed against the new user's paths. There is no code
 * path where user A's DB handle can be alive while user B is signed in.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { app, shell as electronShell } from 'electron';

import { JobStore } from '@core/storage/JobStore';
import { SettingsStore, type AppSettings } from '@core/storage/SettingsStore';
import { prepareDatabase } from '@core/storage/Migrator';
import { MIGRATIONS } from '@core/storage/migrations';
import { GlobalDb, GLOBAL_MIGRATIONS } from '@core/storage/GlobalDb';
import {
  ensureUserTree,
  globalDbPath,
  userPathsFor,
  type UserPaths,
} from '@core/storage/UserDataPaths';
import { RecoveryService, DEFAULT_RECOVERY_OPTIONS } from '@core/recovery/RecoveryService';
import { UploadQueue } from '@core/queue/UploadQueue';
import { SystemClock, type Clock } from '@core/util/Clock';
import { type Logger, noopLogger } from '@core/observability/Logger';
import { createPinoLogger } from '@core/observability/PinoLogger';
import { buildCrashReporter, type ICrashReporter } from '@core/observability/CrashReporter';
import { buildAnalyticsClient, type IAnalyticsClient } from '@core/observability/AnalyticsClient';
import { resolveTwinMindBackendConfig } from '@core/auth/twinmindBackendConfig';
import { TwinMindAuthProvider } from '@core/auth/TwinMindAuthProvider';
import { TwinMindAsrClient } from '@core/asr/TwinMindAsrClient';
import { MockAsrClient } from '@core/asr/MockAsrClient';
import type { IAsrClient } from '@core/asr/IAsrClient';
import { TwinMindSummaryClient } from '@core/summary/TwinMindSummaryClient';
import { ChunkWriter } from '@core/audio/ChunkWriter';
import { WebmEncoder } from '@core/audio/WebmEncoder';
import { RecordingOrchestrator } from '@core/audio/RecordingOrchestrator';
import { DiskMonitor } from '@core/audio/DiskMonitor';
import { MeetingDetectionService } from '@core/meeting/MeetingDetectionService';
import type { AudioProcessLink } from '@core/audio/AudioProcessLink';
import type { ISecureStorage } from '@platform/ISecureStorage';
import type { IPermissionService } from '@platform/IPermissionService';
import type { IPasteService } from '@platform/IPasteService';
import type { INotificationService } from '@platform/INotificationService';
import type { IHotkeyManager } from '@platform/IHotkeyManager';
import type { IGlobeKeyManager } from '@platform/IGlobeKeyManager';
import type { IMicActivityMonitor } from '@platform/IMicActivityMonitor';
import type { IDeviceMonitor } from '@platform/IDeviceMonitor';

/** Bundle of all OS-touching services. Built once in main.ts, used by Shell + ComposedApp. */
export interface PlatformServices {
  readonly secureStorage: ISecureStorage;
  readonly permissions: IPermissionService;
  readonly paste: IPasteService;
  readonly notifications: INotificationService;
  readonly hotkeys: IHotkeyManager;
  readonly micActivity?: IMicActivityMonitor;
  readonly globeKey?: IGlobeKeyManager;
  readonly deviceMonitor: IDeviceMonitor;
}

/**
 * Machine-scoped runtime. Built once at startup; lives for the app's
 * lifetime. Owns the audio link, platform services, global DB, auth, and
 * app-level observability.
 */
export interface Shell {
  readonly userDataDir: string;
  readonly appVersion: string;
  readonly audioLink: AudioProcessLink;
  readonly platform: PlatformServices;
  readonly globalDb: GlobalDb;
  readonly authProvider: TwinMindAuthProvider;
  /** App-level logger; writes to `<userDataDir>/logs/`. Used before sign-in. */
  readonly logger: Logger;
  readonly crash: ICrashReporter;
  readonly analytics: IAnalyticsClient;
  /** Build a per-user ComposedApp. Caller owns its lifetime. Async because
   *  composition runs recovery, which now spawns ffmpeg to re-encode orphan
   *  PCM (and legacy WAV) files left by a prior crash. */
  composeForUser(userId: string): Promise<ComposedApp>;
  /** Tear down shell-only resources (auth timer, global DB, analytics). */
  shutdown(): Promise<void>;
}

/**
 * Per-user runtime. Rebuilt on every sign-in; disposed on sign-out. Holds
 * every object that touches user-scoped state.
 */
export interface ComposedApp {
  readonly userId: string;
  /** The user's per-user directory: `<userData>/users/<slug>`. */
  readonly userDataDir: string;
  readonly db: Database.Database;
  readonly settings: SettingsStore;
  readonly jobStore: JobStore;
  readonly recovery: RecoveryService;
  readonly uploadQueue: UploadQueue;
  readonly asrClient: IAsrClient;
  readonly summaryClient: TwinMindSummaryClient;
  readonly chunkWriter: ChunkWriter;
  readonly orchestrator: RecordingOrchestrator;
  readonly diskMonitor: DiskMonitor;
  readonly meetingDetection: MeetingDetectionService | null;

  // Shell pass-through proxies (so existing main.ts code that reads
  // `composed.platform` / `composed.logger` / `composed.analytics` keeps
  // working unchanged). These are NOT owned by ComposedApp; shutdown()
  // never touches them.
  readonly platform: PlatformServices;
  readonly logger: Logger;
  readonly crash: ICrashReporter;
  readonly analytics: IAnalyticsClient;

  /**
   * Hook called by main.ts after a successful SETTINGS_SET so composition
   * can live-react to mutable settings (e.g. push the input-device picker
   * to the native mic mid-session).
   */
  notifySettingsChanged(): void;

  /** Tear down per-user resources only. Idempotent. */
  shutdown(): Promise<void>;
}

export interface BuildShellInput {
  readonly audioLink: AudioProcessLink;
  readonly platform: PlatformServices;
  readonly appVersion: string;
}

/**
 * Build the machine-scoped shell. Must be called after `app.isReady()`.
 * Does not compose any user-scoped state — caller decides whether/when to
 * call `composeForUser` based on the auth provider's state.
 */
export function buildShell({
  audioLink,
  platform,
  appVersion,
}: BuildShellInput): Shell {
  const userDataDir = app.getPath('userData');
  fs.mkdirSync(path.join(userDataDir, 'logs'), { recursive: true, mode: 0o700 });

  const logger: Logger = (() => {
    try {
      return createPinoLogger({
        level: (process.env.TWINMIND_LOG_LEVEL as 'info') ?? 'info',
        destination: path.join(userDataDir, 'logs', `twinmind-${todayStamp()}.log`),
        pretty: process.env.NODE_ENV === 'development',
      });
    } catch {
      return noopLogger;
    }
  })();
  const crash = buildCrashReporter({
    dsn: process.env.TWINMIND_SENTRY_DSN ?? null,
    release: appVersion,
    scope: 'main',
    logger,
  });
  crash.init();
  const analytics = buildAnalyticsClient({
    apiKey: process.env.TWINMIND_AMPLITUDE_KEY ?? null,
    version: appVersion,
    logger,
  });
  analytics.track('app_launched', { version: appVersion, platform: process.platform });

  // ─── Global DB (user directory + wizard state) ───────────────────────────
  const globalDb = GlobalDb.open(
    () => new Database(globalDbPath(userDataDir)),
    SystemClock,
  );

  // ─── Auth provider (machine-scoped) ──────────────────────────────────────
  const configResolution = resolveTwinMindBackendConfig();
  if (!configResolution.ok) {
    logger.warn('twinmind backend config missing', { missing: configResolution.missing });
  }
  const authProvider = new TwinMindAuthProvider({
    configResolution,
    globalDb,
    secureStorage: platform.secureStorage,
    clock: SystemClock,
    logger,
    openBrowser: (url) => electronShell.openExternal(url),
  });

  return {
    userDataDir,
    appVersion,
    audioLink,
    platform,
    globalDb,
    authProvider,
    logger,
    crash,
    analytics,
    composeForUser(userId: string) {
      return composeForUser({
        shell: {
          userDataDir,
          appVersion,
          audioLink,
          platform,
          globalDb,
          authProvider,
          logger,
          crash,
          analytics,
        },
        userId,
        clock: SystemClock,
      });
    },
    async shutdown() {
      authProvider.shutdown();
      globalDb.close();
      await analytics.flush();
    },
  };
}

/** Inputs to `composeForUser`. Stripped-down view of Shell so tests can
 *  call this directly without a full Shell object. */
interface ComposeForUserInput {
  readonly shell: {
    readonly userDataDir: string;
    readonly appVersion: string;
    readonly audioLink: AudioProcessLink;
    readonly platform: PlatformServices;
    readonly globalDb: GlobalDb;
    readonly authProvider: TwinMindAuthProvider;
    readonly logger: Logger;
    readonly crash: ICrashReporter;
    readonly analytics: IAnalyticsClient;
  };
  readonly userId: string;
  readonly clock: Clock;
}

async function composeForUser({ shell, userId, clock }: ComposeForUserInput): Promise<ComposedApp> {
  const paths: UserPaths = userPathsFor(shell.userDataDir, userId);
  ensureUserTree(paths);

  // Per-user logger writes to the user's logs dir. Anything below this line
  // logs into the *user's* files, not the shell's — keeps a per-user log
  // trail separate from auth/boot events.
  const logger: Logger = (() => {
    try {
      return createPinoLogger({
        level: (process.env.TWINMIND_LOG_LEVEL as 'info') ?? 'info',
        destination: path.join(paths.logsDir, `twinmind-${todayStamp()}.log`),
        pretty: process.env.NODE_ENV === 'development',
      });
    } catch {
      return noopLogger;
    }
  })();

  // ─── Per-user DB ────────────────────────────────────────────────────────
  const db = new Database(paths.dbPath);
  prepareDatabase(db, MIGRATIONS);
  const jobStore = new JobStore(db, clock);
  const settings = new SettingsStore(paths.settingsDir, clock);
  const loaded = settings.load();
  const cfg: AppSettings = loaded.settings;

  // ─── Encoder (shared between ChunkWriter and RecoveryService) ───────────
  // Constructed up here so RecoveryService can re-encode orphan `.pcm` and
  // legacy `.wav` files at launch. Throws if ffmpeg-static can't be resolved
  // for this platform — fail loud rather than degrading silently.
  const webmEncoder = new WebmEncoder();

  // ─── Recovery (runs before anything network-y starts; awaits ffmpeg
  // for orphan-PCM / legacy-WAV re-encoding) ──────────────────────────────
  const recovery = new RecoveryService(
    jobStore,
    clock,
    paths.recordingsDir,
    {
      ...DEFAULT_RECOVERY_OPTIONS,
      retentionMs: cfg.privacy.autoDeleteOlderThanDays * 24 * 60 * 60 * 1000,
    },
    logger,
    webmEncoder,
  );
  const recoveryReport = await recovery.recover();
  if (
    recoveryReport.staleSleepSessions +
      recoveryReport.resetUploading +
      recoveryReport.orphanCompletedFilesDeleted +
      recoveryReport.rowsMarkedFileLost +
      recoveryReport.retentionFilesDeleted +
      recoveryReport.crashRecoveredActive +
      recoveryReport.unresumedDeviceLoss +
      recoveryReport.recoveredOrphanPcms +
      recoveryReport.recoveredOrphanWebms +
      recoveryReport.recoveredLegacyWavs >
    0
  ) {
    const chunksRecovered =
      recoveryReport.resetUploading +
      recoveryReport.recoveredOrphanPcms +
      recoveryReport.recoveredOrphanWebms +
      recoveryReport.recoveredLegacyWavs;
    shell.analytics.track('crash_recovery_performed', {
      chunks_recovered: chunksRecovered,
      sessions_affected:
        recoveryReport.staleSleepSessions +
        recoveryReport.crashRecoveredActive +
        recoveryReport.unresumedDeviceLoss,
      // Per-bucket counters so the dashboard can distinguish a graceful
      // sleep-resume timeout from an actual crash recovery, and track the
      // legacy-WAV shim's usage post-migration.
      crash_recovered_active: recoveryReport.crashRecoveredActive,
      unresumed_device_loss: recoveryReport.unresumedDeviceLoss,
      recovered_orphan_pcms: recoveryReport.recoveredOrphanPcms,
      recovered_orphan_webms: recoveryReport.recoveredOrphanWebms,
      recovered_legacy_wavs: recoveryReport.recoveredLegacyWavs,
    });
  }

  // ─── ASR + summary clients ──────────────────────────────────────────────
  const asrClient: IAsrClient = buildAsrClient(cfg, shell.authProvider, logger);
  const summaryClient = buildSummaryClient(shell.authProvider, logger);

  // ─── Upload queue ───────────────────────────────────────────────────────
  const uploadQueue = new UploadQueue(jobStore, asrClient, clock, {}, logger);
  uploadQueue.on('chunk_completed', (e) => {
    shell.analytics.track('transcription_succeeded', {
      mode: e.segment.text === '' ? 'vad_skipped' : 'normal',
      provider: e.segment.provider,
      audio_sec: e.segment.durationMs / 1000,
    });
  });
  uploadQueue.on('chunk_failed_permanent', (e) => {
    shell.analytics.track('transcription_failed', { error_class: e.errorClass, permanent: true });
  });
  uploadQueue.start();

  // ─── Audio pipeline ─────────────────────────────────────────────────────
  // ChunkWriter shares the same WebmEncoder instance the recovery pass uses;
  // construction happened above. Single instance is fine — encode() is
  // stateless (one ffmpeg subprocess per call).
  const chunkWriter = new ChunkWriter(
    jobStore,
    clock,
    paths.recordingsDir,
    { silenceThresholdDbfs: cfg.advanced.vadSilenceThresholdDbfs },
    webmEncoder,
    logger,
  );
  const orchestrator = new RecordingOrchestrator({
    store: jobStore,
    chunkWriter,
    link: shell.audioLink,
    clock,
    logger,
    // Re-read settings on every session start so the picker change takes
    // effect on the *next* recording without a restart. When the user
    // hasn't pinned a specific device (`inputDeviceId === null`),
    // resolveMicDeviceId() prefers the built-in mic over whatever macOS
    // currently considers the system default — the user explicitly asked
    // for that bias since the Mac built-in has the most consistent ASR
    // quality (no Bluetooth A2DP→HFP profile-switch warmup, no USB jitter).
    getMicDeviceId: () => resolveMicDeviceId(settings, logger),
  });
  orchestrator.on('state_changed', (s) => {
    if (s.state === 'recording') {
      shell.analytics.track('recording_started', { mode: s.mode });
    } else if (s.state === 'idle' && s.mode !== 'idle') {
      shell.analytics.track('recording_stopped', { duration_sec: Math.round(s.elapsedMs / 1000) });
    }
  });

  // ─── Disk monitor: per-user dir is on the same volume; monitor still works. ──
  const diskMonitor = new DiskMonitor({ dir: paths.userDir, logger });
  diskMonitor.onStop(() => {
    if (orchestrator.state === 'recording') {
      logger.error('disk full — forcing stop');
      orchestrator.stop('disk_full');
    }
  });
  diskMonitor.start();

  // ─── Meeting auto-detection (optional — needs the native addon) ─────────
  const meetingDetection = shell.platform.micActivity
    ? new MeetingDetectionService({
        monitor: shell.platform.micActivity,
        store: jobStore,
        clock,
        // Wizard completion is machine-scoped — read from globalDb.
        isOnboardingComplete: () => shell.globalDb.getOnboardingCompletedAt() !== null,
        isOwnCaptureActive: () => orchestrator.state === 'recording',
        isFeatureEnabled: () => cfg.meetingDetection.enabled,
        logger,
      })
    : null;
  if (meetingDetection) meetingDetection.start();

  return {
    userId,
    userDataDir: paths.userDir,
    db,
    settings,
    jobStore,
    recovery,
    uploadQueue,
    asrClient,
    summaryClient,
    chunkWriter,
    orchestrator,
    diskMonitor,
    meetingDetection,
    platform: shell.platform,
    logger,
    crash: shell.crash,
    analytics: shell.analytics,
    notifySettingsChanged() {
      // Same null → built-in resolution as session-start. If the user
      // cleared their pinned device while recording, the live capture
      // switches to the built-in mic rather than the OS default.
      orchestrator.setMicDevice(resolveMicDeviceId(settings, logger));
    },
    async shutdown() {
      const wasRecording = orchestrator.state === 'recording';
      if (wasRecording) orchestrator.stop('shutdown');
      meetingDetection?.stop();
      diskMonitor.stop();
      // Wait for any in-flight closeChunk encodes to settle BEFORE tearing
      // down the upload queue / DB. Without this we'd race ffmpeg against
      // db.close() and could leave a half-encoded `.webm` on disk that the
      // orphan-WebM recovery pass would re-pick up next launch.
      await orchestrator.drainPendingChunkCloses();
      await uploadQueue.stop();
      // If we were recording, any chunks still mid-capture (their
      // chunk_closed reply never landed before utility-process teardown)
      // have their `.pcm` left on disk for next-launch recovery. When not
      // recording, abortAll just clears the (empty) active map.
      if (wasRecording) {
        chunkWriter.finalizeAllOnShutdown();
      } else {
        chunkWriter.abortAll();
      }
      // Don't flush analytics here — it's shell-owned, shared with the next
      // composed app. Shell.shutdown handles the final flush at app quit.
      db.close();
    },
  };
}

/**
 * Pick the right ASR client based on settings + env. TwinMind is the only
 * real backend now; `mock` stays for tests via the `TWINMIND_ASR_PROVIDER=mock`
 * env override (or `settings.advanced.asrProvider = 'mock'`).
 */
function buildAsrClient(
  cfg: AppSettings,
  authProvider: TwinMindAuthProvider,
  logger: Logger,
): IAsrClient {
  const envProvider = process.env.TWINMIND_ASR_PROVIDER as 'twinmind' | 'mock' | undefined;
  const provider = envProvider ?? cfg.advanced.asrProvider;

  if (provider === 'mock') {
    return new MockAsrClient({ defaultText: '(mock transcript)' });
  }

  // The TwinMind path; the only real backend.
  const cfgResolution = resolveTwinMindBackendConfig();
  if (!cfgResolution.ok) {
    // Build the client anyway — it'll throw AsrError('auth') when called.
    // That's preferable to crashing the app at compose time on a missing env
    // var; Settings → Account surfaces the missing list to the user.
    logger.warn('asr client: backend config missing; transcribes will fail until configured', {
      missing: cfgResolution.missing,
    });
  }
  // Even when config is missing, provide a stub config so the client constructs
  // without throwing — getAccessToken() will reject and the client maps that
  // to AsrError('auth'). The IPC layer surfaces the same configMissing state.
  const safeConfig = cfgResolution.ok
    ? cfgResolution.config
    : {
        transcribeUrl: 'about:blank',
        vercelProtectionBypass: '',
        dictationModel: 'twinmind-fast-3',
        meetingModel: 'twinmind-pro',
        summaryUrl: 'about:blank',
        appUrl: 'https://app.twinmind.com',
      };
  return new TwinMindAsrClient({
    config: safeConfig,
    auth: {
      getAccessToken: () => authProvider.getAccessToken(),
      refreshAccessToken: () => authProvider.refreshNow(),
    },
    logger,
  });
}

/**
 * Build the per-meeting summary client. Always TwinMind; tests can opt out
 * by simply not invoking the trigger. Uses the same auth provider as the
 * ASR client (one Firebase identity per user).
 */
function buildSummaryClient(
  authProvider: TwinMindAuthProvider,
  logger: Logger,
): TwinMindSummaryClient {
  const cfgResolution = resolveTwinMindBackendConfig();
  const safeConfig = cfgResolution.ok
    ? cfgResolution.config
    : { summaryUrl: 'about:blank', vercelProtectionBypass: '' };
  return new TwinMindSummaryClient({
    config: { summaryUrl: safeConfig.summaryUrl, vercelProtectionBypass: safeConfig.vercelProtectionBypass },
    auth: {
      getAccessToken: () => authProvider.getAccessToken(),
      refreshAccessToken: () => authProvider.refreshNow(),
    },
    logger,
  });
}

/** YYYY-MM-DD stamp for daily log rotation. */
function todayStamp(): string {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

/**
 * Resolve the device id to open for recording. Honors the user's pinned
 * pick when set; when null, prefers the Mac's built-in microphone — the
 * Settings UI documents this as the "recommended" default. Falls back to
 * null (OS default) when no built-in is enumerated, which is the same
 * behavior as before this resolver existed.
 *
 * Failures of the native enumeration call (Linux/Windows builds where the
 * darwin addon isn't present, or a CoreAudio hiccup) degrade to null
 * silently — the audio-process can still open the OS default mic.
 */
function resolveMicDeviceId(settings: SettingsStore, logger: Logger): string | null {
  const stored = settings.load().settings.recording.inputDeviceId;
  if (stored !== null) return stored;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const native = require('@twinmind/coreaudio-darwin') as {
      listInputDevices?: () => Array<{ id: string; kind: string }>;
    };
    const devices =
      typeof native.listInputDevices === 'function' ? native.listInputDevices() : [];
    const builtIn = devices.find((d) => d.kind === 'built_in');
    return builtIn?.id ?? null;
  } catch (err) {
    logger.warn('resolveMicDeviceId: native device listing failed; falling back to OS default', {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ─── Backward-compat: re-export GLOBAL_MIGRATIONS so callers don't need a
//     separate import path. The Shell construction wires it internally.
export { GLOBAL_MIGRATIONS };
