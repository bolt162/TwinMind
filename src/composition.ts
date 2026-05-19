/**
 * Composition root — the one place where concrete services meet.
 *
 * Architecture: §5 (Composition pattern), §17.1 (TwinMind backend swap is a
 * one-line change here), §19 (composition principles).
 *
 * Read this file top-to-bottom to understand what the app actually is. Every
 * `new X()` for a non-trivial service lives here; the rest of the codebase
 * depends on interfaces. Changing providers (Groq → TwinMind, Noop → OAuth,
 * mock → native mic) is a few lines in this file plus zero in the rest.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { app } from 'electron';

import { JobStore } from '@core/storage/JobStore';
import { SettingsStore, type AppSettings } from '@core/storage/SettingsStore';
import { prepareDatabase } from '@core/storage/Migrator';
import { MIGRATIONS } from '@core/storage/migrations';
import { RecoveryService, DEFAULT_RECOVERY_OPTIONS } from '@core/recovery/RecoveryService';
import { UploadQueue } from '@core/queue/UploadQueue';
import { SystemClock } from '@core/util/Clock';
import { type Logger, noopLogger } from '@core/observability/Logger';
import { createPinoLogger } from '@core/observability/PinoLogger';
import { buildCrashReporter, type ICrashReporter } from '@core/observability/CrashReporter';
import { buildAnalyticsClient, type IAnalyticsClient } from '@core/observability/AnalyticsClient';
import { NoopAuthProvider } from '@core/auth/NoopAuthProvider';
import type { IAuthProvider } from '@core/auth/IAuthProvider';
import { GroqAsrClient } from '@core/asr/GroqAsrClient';
import { MockAsrClient } from '@core/asr/MockAsrClient';
import type { IAsrClient } from '@core/asr/IAsrClient';
import { ChunkWriter } from '@core/audio/ChunkWriter';
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

/** Bundle of all OS-touching services; built in `main.ts` and passed to compose(). */
export interface PlatformServices {
  readonly secureStorage: ISecureStorage;
  readonly permissions: IPermissionService;
  readonly paste: IPasteService;
  readonly notifications: INotificationService;
  readonly hotkeys: IHotkeyManager;
  /** Optional — may be absent when the native addon isn't built. */
  readonly micActivity?: IMicActivityMonitor;
  /** Optional — macOS-only and absent when the Swift listener binary isn't built. */
  readonly globeKey?: IGlobeKeyManager;
  readonly deviceMonitor: IDeviceMonitor;
}

/**
 * Everything the running app needs after wiring. Returned by `compose()` so
 * `main.ts` can use it to wire IPC and start the UI.
 */
export interface ComposedApp {
  readonly userDataDir: string;
  readonly db: Database.Database;
  readonly settings: SettingsStore;
  readonly jobStore: JobStore;
  readonly recovery: RecoveryService;
  readonly uploadQueue: UploadQueue;
  readonly authProvider: IAuthProvider;
  readonly asrClient: IAsrClient;
  readonly chunkWriter: ChunkWriter;
  readonly orchestrator: RecordingOrchestrator;
  readonly diskMonitor: DiskMonitor;
  readonly meetingDetection: MeetingDetectionService | null;
  readonly platform: PlatformServices;
  readonly logger: Logger;
  readonly crash: ICrashReporter;
  readonly analytics: IAnalyticsClient;
  /** Tear everything down in reverse order (used at app quit). */
  shutdown(): Promise<void>;
}

export interface ComposeInput {
  /** Live link to the `audio-process` utility process; created by main.ts. */
  readonly audioLink: AudioProcessLink;
  /** Per-platform OS services built in main.ts (mac wires darwin/, win → win32/). */
  readonly platform: PlatformServices;
  /** App version (used by analytics + Sentry). */
  readonly appVersion: string;
}

/**
 * Build the app. The caller (main.ts) must have `app.isReady()` already, since
 * we read `app.getPath('userData')` to locate the DB and settings, and must
 * have spawned the audio-process so the `audioLink` is alive.
 */
export function compose({ audioLink, platform, appVersion }: ComposeInput): ComposedApp {
  const userDataDir = app.getPath('userData');
  fs.mkdirSync(path.join(userDataDir, 'logs'), { recursive: true, mode: 0o700 });

  // ─── Observability (built first; everything else uses these) ───────────
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

  // ─── Storage ────────────────────────────────────────────────────────────
  const dbPath = path.join(userDataDir, 'app.db');
  const db = new Database(dbPath);
  prepareDatabase(db, MIGRATIONS);
  const jobStore = new JobStore(db, SystemClock);
  const settings = new SettingsStore(userDataDir, SystemClock);

  // First-load: writes defaults if file is absent; recovers from .broken otherwise.
  const loaded = settings.load();
  const cfg: AppSettings = loaded.settings;

  // ─── Recovery (run synchronously before anything network-y starts) ──────
  const recovery = new RecoveryService(jobStore, SystemClock, {
    ...DEFAULT_RECOVERY_OPTIONS,
    retentionMs: cfg.privacy.autoDeleteOlderThanDays * 24 * 60 * 60 * 1000,
  });
  const recoveryReport = recovery.recover();
  if (
    recoveryReport.staleSleepSessions +
      recoveryReport.resetUploading +
      recoveryReport.orphanCompletedFilesDeleted +
      recoveryReport.rowsMarkedFileLost +
      recoveryReport.retentionFilesDeleted >
    0
  ) {
    analytics.track('crash_recovery_performed', {
      chunks_recovered: recoveryReport.resetUploading,
      sessions_affected: recoveryReport.staleSleepSessions,
    });
  }

  // ─── Auth + ASR ─────────────────────────────────────────────────────────
  const authProvider: IAuthProvider = new NoopAuthProvider();
  const asrClient: IAsrClient = buildAsrClient(cfg, jobStore, platform.secureStorage, logger);

  // ─── Upload queue ───────────────────────────────────────────────────────
  const uploadQueue = new UploadQueue(jobStore, asrClient, SystemClock, {}, logger);
  uploadQueue.on('chunk_completed', (e) => {
    analytics.track('transcription_succeeded', {
      mode: e.segment.text === '' ? 'vad_skipped' : 'normal',
      provider: e.segment.provider,
      audio_sec: e.segment.durationMs / 1000,
    });
  });
  uploadQueue.on('chunk_failed_permanent', (e) => {
    analytics.track('transcription_failed', { error_class: e.errorClass, permanent: true });
  });
  uploadQueue.start();

  // ─── Audio pipeline ─────────────────────────────────────────────────────
  const recordingsDir = path.join(userDataDir, 'recordings');
  fs.mkdirSync(recordingsDir, { recursive: true, mode: 0o700 });

  const chunkWriter = new ChunkWriter(
    jobStore,
    SystemClock,
    recordingsDir,
    { silenceThresholdDbfs: cfg.advanced.vadSilenceThresholdDbfs },
    logger,
  );
  const orchestrator = new RecordingOrchestrator({
    store: jobStore,
    chunkWriter,
    link: audioLink,
    clock: SystemClock,
    logger,
  });
  orchestrator.on('state_changed', (s) => {
    if (s.state === 'recording') {
      analytics.track('recording_started', { mode: s.mode });
    } else if (s.state === 'idle' && s.mode !== 'idle') {
      analytics.track('recording_stopped', { duration_sec: Math.round(s.elapsedMs / 1000) });
    }
  });

  // ─── Disk monitor: warn at 2 GB, force-stop at 200 MB ───────────────────
  const diskMonitor = new DiskMonitor({ dir: userDataDir, logger });
  diskMonitor.onStop(() => {
    if (orchestrator.state === 'recording') {
      logger.error('disk full — forcing stop');
      orchestrator.stop('disk_full');
    }
  });
  diskMonitor.start();

  // ─── Meeting auto-detection (optional — needs the native addon) ─────────
  const meetingDetection = platform.micActivity
    ? new MeetingDetectionService({
        monitor: platform.micActivity,
        store: jobStore,
        clock: SystemClock,
        isOnboardingComplete: () => cfg.onboardingCompletedAt !== null,
        isOwnCaptureActive: () => orchestrator.state === 'recording',
        isFeatureEnabled: () => cfg.meetingDetection.enabled,
        logger,
      })
    : null;
  if (meetingDetection) meetingDetection.start();

  return {
    userDataDir,
    db,
    settings,
    jobStore,
    recovery,
    uploadQueue,
    authProvider,
    asrClient,
    chunkWriter,
    orchestrator,
    diskMonitor,
    meetingDetection,
    platform,
    logger,
    crash,
    analytics,
    async shutdown() {
      if (orchestrator.state === 'recording') orchestrator.stop('shutdown');
      meetingDetection?.stop();
      diskMonitor.stop();
      platform.hotkeys.unregisterAll();
      platform.globeKey?.stop();
      await uploadQueue.stop();
      chunkWriter.abortAll();
      await analytics.flush();
      db.close();
    },
  };
}

/**
 * Pick the right ASR client based on settings + env. Single switch. The Groq
 * key is encrypted on disk in JobStore.kv; we decrypt on every call so a
 * settings rotation takes effect on the next request without restart.
 */
function buildAsrClient(
  cfg: AppSettings,
  jobStore: JobStore,
  secure: ISecureStorage,
  logger: Logger,
): IAsrClient {
  const envProvider = process.env.TWINMIND_ASR_PROVIDER as 'groq' | 'twinmind' | 'mock' | undefined;
  const provider = envProvider ?? cfg.advanced.asrProvider;

  switch (provider) {
    case 'mock':
      return new MockAsrClient({ defaultText: '(mock transcript)' });
    case 'twinmind':
      throw new Error('TwinMind ASR backend not yet implemented (§17.1)');
    case 'groq':
    default:
      return new GroqAsrClient({
        config: { model: process.env.GROQ_MODEL ?? 'whisper-large-v3' },
        // `groq_api_key_enc` is the encrypted payload; `GROQ_API_KEY` is a
        // dev escape hatch read straight from env.
        getApiKey: () => readGroqApiKey(jobStore, secure),
        logger,
      });
  }
}

/**
 * Decrypt the persisted Groq key (or fall back to env). Best-effort.
 *
 * Caches the (encrypted-blob → cleartext) pair in process memory so we hit
 * `safeStorage.decryptString` (and therefore Keychain) at most ONCE per app
 * launch instead of once per ASR call. The cache keys on the encrypted blob
 * itself, so when the user rotates the API key via SETTINGS_SET_SECRET the
 * KV row changes and the next call automatically misses + re-decrypts —
 * no explicit invalidation API needed.
 *
 * Result on macOS: zero Keychain accesses after the first one per launch,
 * which (combined with stable Developer ID code-signing) is what eliminates
 * the "random keychain prompt mid-session" we used to see.
 */
let cachedDecrypt: { enc: string; clear: string } | null = null;

function readGroqApiKey(jobStore: JobStore, secure: ISecureStorage): string | null {
  const enc = jobStore.getKv('groq_api_key_enc');
  if (enc) {
    if (cachedDecrypt && cachedDecrypt.enc === enc) return cachedDecrypt.clear;
    try {
      const clear = secure.decrypt(enc);
      cachedDecrypt = { enc, clear };
      return clear;
    } catch {
      // Encrypted blob unreadable (different user / corrupt). Fall through to env.
    }
  }
  return process.env.GROQ_API_KEY ?? null;
}

/** Build a YYYY-MM-DD stamp for daily log rotation. */
function todayStamp(): string {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}
