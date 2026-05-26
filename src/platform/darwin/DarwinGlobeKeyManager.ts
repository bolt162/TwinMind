/**
 * DarwinGlobeKeyManager — Fn/Globe key listener (macOS).
 *
 * Architecture: §5 (composite hotkey source). Thin wrapper over the
 * `@twinmind/coreaudio-darwin` native addon's `globeKey()` factory, which
 * runs a CGEventTap inside the main process on a dedicated thread.
 *
 * Why in-process: the previous implementation spawned a separate Swift
 * binary, but macOS TCC tracks Accessibility per-binary-identifier — users
 * had to grant Accessibility twice (TwinMind.app + macos-globe-listener).
 * Running the tap inside the main process makes Fn subject to TwinMind's
 * single Accessibility grant.
 *
 * Failure modes (graceful):
 *   - Native addon missing → `start()` logs once and stays a no-op. Fn is
 *     unavailable but everything else keeps working.
 *   - Accessibility denied at start → poll every 2s and retry, so granting
 *     the permission mid-session activates Fn without an app restart. The
 *     poll stops as soon as a start attempt succeeds (or stop() is called).
 */

import type { IGlobeKeyManager } from '../IGlobeKeyManager';
import { type Logger, noopLogger } from '@core/observability/Logger';

interface NativeGlobeKey {
  start(): boolean;
  stop(): void;
  on(event: 'press', cb: () => void): () => void;
  on(event: 'release', cb: () => void): () => void;
  /**
   * Fired when the native CGEventTap detected an unrecoverable disable
   * (Accessibility revoked, or repeated re-enable failures). The native
   * side has already torn down the tap; the manager should mark the tap
   * uninstalled and re-arm the retry poll so re-granting recovers
   * automatically without an app restart.
   */
  on(event: 'tap_lost', cb: () => void): () => void;
}

interface NativeModule {
  globeKey?: () => NativeGlobeKey;
}

const ACCESSIBILITY_POLL_MS = 2000;

export class DarwinGlobeKeyManager implements IGlobeKeyManager {
  private instance: NativeGlobeKey | null = null;
  private installed = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly pressHandlers = new Set<() => void>();
  private readonly releaseHandlers = new Set<() => void>();
  private accessibilityWarned = false;
  private addonWarned = false;

  constructor(private readonly logger: Logger = noopLogger) {}

  start(): void {
    if (this.installed) return;
    this.stopped = false;

    if (!this.instance) {
      this.instance = this.createInstance();
      if (!this.instance) return; // addon missing — already warned
    }

    if (this.instance.start()) {
      this.installed = true;
      this.accessibilityWarned = false;
      this.clearRetryTimer();
      this.logger.info('globe-key tap installed');
      return;
    }

    if (!this.accessibilityWarned) {
      this.accessibilityWarned = true;
      this.logger.warn(
        'globe-key tap: Accessibility permission missing for TwinMind — will retry every 2s',
      );
    }
    this.scheduleRetry();
  }

  stop(): void {
    this.stopped = true;
    this.clearRetryTimer();
    if (this.instance) {
      try {
        this.instance.stop();
      } catch {
        /* best-effort */
      }
      this.instance = null;
    }
    this.installed = false;
    this.pressHandlers.clear();
    this.releaseHandlers.clear();
  }

  onPress(handler: () => void): () => void {
    this.pressHandlers.add(handler);
    return () => this.pressHandlers.delete(handler);
  }

  onRelease(handler: () => void): () => void {
    this.releaseHandlers.add(handler);
    return () => this.releaseHandlers.delete(handler);
  }

  /** Build the native instance once and wire fan-out subscriptions. The
   *  subscriptions stay attached across failed start attempts. */
  private createInstance(): NativeGlobeKey | null {
    let mod: NativeModule;
    try {
      mod = require('@twinmind/coreaudio-darwin') as NativeModule;
    } catch (err) {
      if (!this.addonWarned) {
        this.addonWarned = true;
        this.logger.warn('globe-key native addon unavailable — Fn disabled', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return null;
    }
    if (typeof mod.globeKey !== 'function') {
      if (!this.addonWarned) {
        this.addonWarned = true;
        this.logger.warn('globe-key export missing from coreaudio-darwin — rebuild required');
      }
      return null;
    }
    const inst = mod.globeKey();
    inst.on('press', () => this.fanout(this.pressHandlers, 'press'));
    inst.on('release', () => this.fanout(this.releaseHandlers, 'release'));
    inst.on('tap_lost', () => this.onTapLost());
    return inst;
  }

  /**
   * Native told us the tap is dead. Re-arm exactly the same recovery path
   * we use when start() returns false: mark uninstalled, log once per
   * loss event, and let the 2 s poll re-attempt start() — which itself
   * re-checks AXIsProcessTrustedWithOptions before touching CGEventTap.
   *
   * We intentionally do NOT call instance.stop() here: native already
   * stopped the runloop and released the CFMachPort. Calling stop() again
   * would just no-op on the worker thread that's already exited.
   */
  private onTapLost(): void {
    if (!this.installed && this.retryTimer) return;
    this.installed = false;
    this.accessibilityWarned = false; // re-arm the one-shot warning
    this.logger.warn('globe-key tap lost (Accessibility likely revoked); will retry every 2s');
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.stopped) return;
    this.retryTimer = setInterval(() => {
      if (this.stopped || this.installed || !this.instance) {
        this.clearRetryTimer();
        return;
      }
      if (this.instance.start()) {
        this.installed = true;
        this.clearRetryTimer();
        this.logger.info('globe-key tap installed after Accessibility grant');
      }
    }, ACCESSIBILITY_POLL_MS);
    // Don't keep the event loop alive just for the retry poll.
    this.retryTimer.unref?.();
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private fanout(handlers: Set<() => void>, label: 'press' | 'release'): void {
    for (const h of handlers) {
      try {
        h();
      } catch (err) {
        this.logger.error(`globe ${label} handler threw`, {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
