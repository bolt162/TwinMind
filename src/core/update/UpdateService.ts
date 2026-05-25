/**
 * UpdateService — auto-update state machine on top of `electron-updater`.
 *
 * Machine-scoped (lives on Shell). Wraps the `autoUpdater` singleton from
 * `electron-updater` and exposes a small surface:
 *
 *   startScheduler()  — kick off the initial check after a short delay and
 *                       schedule a recurring check every 4 hours. Idempotent.
 *                       main.ts calls this when a user signs in.
 *   stopScheduler()   — pause the periodic checks. main.ts calls this on
 *                       sign-out so unauthenticated clients don't hit the
 *                       update endpoint. In-flight checks are not cancelled.
 *   checkNow()        — manual user-triggered check from Settings → Updates.
 *   quitAndInstall()  — restart and apply the downloaded update. Refuses with
 *                       `recording_active` while audio is being captured —
 *                       that is the one user-data-loss-risk path we hard
 *                       block. Refuses with `not_ready` if the state machine
 *                       isn't in `ready`.
 *   getState()        — current snapshot.
 *   onStateChange()   — subscribe to transitions; main.ts broadcasts each one
 *                       over IPC to all renderer windows.
 *
 * State machine:
 *
 *     idle ─────→ checking ─→ available ─→ downloading ─→ ready
 *      ▲             │                                         │
 *      │             ▼                                         ▼
 *      └────  up-to-date                                 (user clicks install)
 *      │                                                       │
 *      └──────  error  ←────────────────────────────────────────┘
 *
 * Disabled-mode (`!app.isPackaged` or non-darwin) is a no-op: every method
 * returns immediately and the broadcast state carries `disabled: true` so the
 * renderer can grey out the manual button. Configuring the updater in dev
 * tries to SHA-check unsigned `.app` bundles and fails noisily; we just
 * skip the whole thing.
 *
 * Why the recording guard lives here and not in main.ts: the only safe spot
 * to read it is *immediately before* `autoUpdater.quitAndInstall()`. Main
 * passes a closure `() => boolean` at construction time so this file has no
 * direct knowledge of the orchestrator.
 */

import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { Logger } from '@core/observability/Logger';
import type { IAnalyticsClient } from '@core/observability/AnalyticsClient';
import type { UpdatePhase, UpdateStateChanged } from '@ipc/channels';

export interface UpdateServiceDeps {
  readonly logger: Logger;
  readonly analytics: IAnalyticsClient;
  readonly appVersion: string;
  /**
   * Returns true iff a recording session is currently capturing audio. Read
   * synchronously at the call to `quitAndInstall()`; never cached so the
   * check is always against the live orchestrator state.
   */
  readonly isRecording: () => boolean;
}

/** Initial check delay after `startScheduler()` is called. Spec §6 says
 *  30-60 s; we pick 60 s to clear startup recovery / first DB open. */
const INITIAL_CHECK_DELAY_MS = 60_000;

/** Recurring check interval. Spec §6 says every 4 hours. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

type Listener = (state: UpdateStateChanged) => void;

/** Coarse classification used by the renderer for copy + analytics buckets. */
function classifyError(
  message: string,
): 'network' | 'integrity' | 'signature' | 'unknown' {
  const m = message.toLowerCase();
  if (
    m.includes('sha512') ||
    m.includes('checksum') ||
    m.includes('integrity')
  ) {
    return 'integrity';
  }
  if (
    m.includes('signature') ||
    m.includes('codesign') ||
    m.includes('developer id')
  ) {
    return 'signature';
  }
  if (
    m.includes('econnrefused') ||
    m.includes('enotfound') ||
    m.includes('etimedout') ||
    m.includes('network') ||
    m.includes('getaddrinfo')
  ) {
    return 'network';
  }
  return 'unknown';
}

/**
 * Pipe electron-updater's verbose internal logs into our Logger. The library
 * accepts a pino-shaped object; we adapt to the project's Logger interface.
 * Prefixed so log lines from the library are searchable.
 */
function makeUpdaterLogger(logger: Logger): {
  info: (m: unknown) => void;
  warn: (m: unknown) => void;
  error: (m: unknown) => void;
  debug: (m: unknown) => void;
} {
  return {
    info: (m) => logger.info('update-lib: ' + String(m)),
    warn: (m) => logger.warn('update-lib: ' + String(m)),
    error: (m) => logger.error('update-lib: ' + String(m)),
    debug: (m) => logger.debug('update-lib: ' + String(m)),
  };
}

export class UpdateService {
  private state: UpdateStateChanged;
  private readonly listeners = new Set<Listener>();
  private initialTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private schedulerRunning = false;
  private readonly disabled: boolean;

  constructor(private readonly deps: UpdateServiceDeps) {
    // Dev runs and non-darwin platforms: the updater would try to SHA-check
    // an unsigned `.app` and surface noise into the renderer. Hard-disable
    // and short-circuit every public method.
    this.disabled = !app.isPackaged || process.platform !== 'darwin';
    this.state = {
      phase: 'idle',
      version: null,
      progressPercent: null,
      error: null,
      disabled: this.disabled,
      currentVersion: deps.appVersion,
    };

    if (this.disabled) {
      this.deps.logger.info('update-service: disabled', {
        reason: !app.isPackaged ? 'dev_build' : 'platform_not_darwin',
      });
      return;
    }

    // Spec §6: download in the background, but never install at quit. The
    // user always clicks "Restart & Update" explicitly — surprising users by
    // mutating their app on quit is worse than waiting for their click.
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.logger = makeUpdaterLogger(deps.logger);

    this.bindEvents();
  }

  /**
   * Start periodic checks. Called by main.ts when the auth provider reports
   * a signed-in user. Idempotent: a second call while running is a no-op so
   * a flurry of auth transitions (rare) doesn't pile up timers.
   */
  startScheduler(): void {
    if (this.disabled || this.schedulerRunning) return;
    this.schedulerRunning = true;
    this.deps.logger.info('update-service: scheduler started', {
      initialDelayMs: INITIAL_CHECK_DELAY_MS,
      intervalMs: CHECK_INTERVAL_MS,
    });
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      void this.runCheck('scheduled');
    }, INITIAL_CHECK_DELAY_MS);
    this.intervalTimer = setInterval(() => {
      void this.runCheck('scheduled');
    }, CHECK_INTERVAL_MS);
  }

  /**
   * Stop periodic checks. Called by main.ts on sign-out so we don't poll the
   * endpoint while unauthenticated. Any in-flight check completes normally;
   * the state machine is not reset (a download already in progress finishes,
   * a `ready` state persists across the sign-out so the banner reappears on
   * the next sign-in without re-downloading).
   */
  stopScheduler(): void {
    if (!this.schedulerRunning) return;
    this.schedulerRunning = false;
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    this.deps.logger.info('update-service: scheduler stopped');
  }

  /** Manual check from Settings → Updates. No-op when disabled or already in flight. */
  checkNow(): void {
    if (this.disabled) return;
    void this.runCheck('manual');
  }

  /**
   * Apply the downloaded update by quitting and relaunching. Hard-blocks
   * during a live recording — the spec calls out this is the only critical
   * guard for not destroying user data. Returns synchronously; on success
   * the process exits before the IPC reply lands at the renderer (which is
   * harmless — the renderer is also exiting).
   */
  quitAndInstall(): { ok: boolean; error?: 'recording_active' | 'not_ready' } {
    if (this.disabled || this.state.phase !== 'ready') {
      return { ok: false, error: 'not_ready' };
    }
    if (this.deps.isRecording()) {
      this.deps.analytics.track('update_install_blocked_by_recording', {
        version: this.state.version,
      });
      this.deps.logger.info('update-service: install blocked, recording active');
      return { ok: false, error: 'recording_active' };
    }
    this.deps.analytics.track('update_install_clicked', {
      from_version: this.deps.appVersion,
      to_version: this.state.version,
    });
    this.deps.logger.info('update-service: quitAndInstall', {
      toVersion: this.state.version,
    });
    try {
      // isSilent=false: Windows installer would show UI; macOS ignores.
      // isForceRunAfter=true: relaunch after install. Default on macOS, but
      // explicit so behavior doesn't drift if we ever target Windows.
      autoUpdater.quitAndInstall(false, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger.error('update-service: quitAndInstall threw', { message });
      this.transition({
        phase: 'error',
        version: this.state.version,
        progressPercent: null,
        error: { code: 'unknown', message },
      });
      return { ok: false, error: 'not_ready' };
    }
    return { ok: true };
  }

  getState(): UpdateStateChanged {
    return this.state;
  }

  onStateChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async shutdown(): Promise<void> {
    this.stopScheduler();
    this.listeners.clear();
  }

  // ─── private ─────────────────────────────────────────────────────────────

  private async runCheck(trigger: 'scheduled' | 'manual'): Promise<void> {
    // Coalesce: if a check is already in flight, skip. A second concurrent
    // checkForUpdates call would have the library log warnings and confuse
    // the event order.
    if (this.state.phase === 'checking' || this.state.phase === 'downloading') {
      this.deps.logger.debug('update-service: check skipped, already in flight', {
        phase: this.state.phase,
      });
      return;
    }
    // Don't clobber an existing `ready` state — if the user already has a
    // downloaded update sitting waiting for click, re-checking shouldn't
    // erase the banner. The library will fire `update-available` again with
    // the same or newer version if the manifest still advertises it; the
    // state machine handles that.
    if (this.state.phase !== 'ready') {
      this.transition({
        phase: 'checking',
        version: null,
        progressPercent: null,
        error: null,
      });
    }
    this.deps.analytics.track('update_check_started', { trigger });
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      // The 'error' event will also fire for most failures; this catch is
      // for the rare immediate throw (config missing, malformed URL). Read
      // the current phase fresh — TS can't narrow across `transition()`
      // calls (state mutation isn't tracked), and we only want to emit if
      // the event handler hasn't already moved us out of 'checking'.
      const message = err instanceof Error ? err.message : String(err);
      // Cast because TS narrowed phase from the earlier guards and doesn't
      // know `transition()` mutated it back to 'checking'.
      const currentPhase = this.state.phase as UpdatePhase;
      if (currentPhase === 'checking') {
        this.transition({
          phase: 'error',
          version: null,
          progressPercent: null,
          error: { code: classifyError(message), message },
        });
      }
    }
  }

  private bindEvents(): void {
    autoUpdater.on('checking-for-update', () => {
      if (this.state.phase !== 'checking' && this.state.phase !== 'ready') {
        this.transition({
          phase: 'checking',
          version: null,
          progressPercent: null,
          error: null,
        });
      }
    });

    autoUpdater.on('update-available', (info: { version: string }) => {
      this.deps.analytics.track('update_available', {
        from_version: this.deps.appVersion,
        to_version: info.version,
      });
      this.transition({
        phase: 'available',
        version: info.version,
        progressPercent: 0,
        error: null,
      });
    });

    autoUpdater.on('update-not-available', () => {
      // Only fall back to idle if we're not already sitting on a ready update
      // from a prior cycle. (Shouldn't happen — if the manifest still has the
      // newer version, the library fires `update-available` first — but guard
      // against odd CDN states where one check sees newer and the next sees
      // same.)
      if (this.state.phase !== 'ready') {
        this.transition({
          phase: 'idle',
          version: null,
          progressPercent: null,
          error: null,
        });
      }
    });

    autoUpdater.on('download-progress', (p: { percent: number }) => {
      this.transition({
        phase: 'downloading',
        version: this.state.version,
        progressPercent: Math.round(p.percent),
        error: null,
      });
    });

    autoUpdater.on('update-downloaded', (info: { version: string }) => {
      this.deps.analytics.track('update_downloaded', {
        from_version: this.deps.appVersion,
        to_version: info.version,
      });
      this.deps.logger.info('update-service: download complete', {
        version: info.version,
      });
      this.transition({
        phase: 'ready',
        version: info.version,
        progressPercent: 100,
        error: null,
      });
    });

    autoUpdater.on('error', (err) => {
      const message = err instanceof Error ? err.message : String(err);
      const code = classifyError(message);
      // Spec §6: check failures (404, network) are silent — log only. We
      // still surface 'error' in state so Settings → Updates can show a
      // muted "Last check failed" line, but the Home banner only renders
      // on `ready`, so end users see nothing for transient failures.
      this.deps.logger.warn('update-service: error event', { message, code });
      this.deps.analytics.track('update_error', { code });
      this.transition({
        phase: 'error',
        version: this.state.version,
        progressPercent: null,
        error: { code, message },
      });
    });
  }

  private transition(
    partial: Omit<UpdateStateChanged, 'disabled' | 'currentVersion'>,
  ): void {
    const next: UpdateStateChanged = {
      ...partial,
      disabled: this.disabled,
      currentVersion: this.deps.appVersion,
    };
    this.state = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch (err) {
        // A buggy listener must not break the state machine; log and move on.
        this.deps.logger.warn('update-service: listener threw', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
