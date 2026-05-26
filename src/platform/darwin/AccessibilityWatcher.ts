/**
 * AccessibilityWatcher — polls macOS TCC trust state and emits transitions.
 *
 * Why this exists: revoking Accessibility for TwinMind mid-session previously
 * froze the host system (see GlobeKey.mm — runaway CGEventTap re-enable loop).
 * The native fix stops the freeze; this watcher gives the app a chance to
 * REACT: stop the Globe-key tap cleanly, stop uiohook (also a CGEventTap),
 * and surface a banner so the user knows Fn / configurable hotkeys won't
 * work until they re-grant.
 *
 * Implementation: a boring 1.5 s `setInterval` poll of
 * `systemPreferences.isTrustedAccessibilityClient(false)` (non-prompting).
 * We don't use macOS's undocumented DistributedNotificationCenter signals
 * for TCC changes — they're unreliable across versions, and a poll at this
 * cadence is invisible in CPU profiles. `unref()` keeps the timer from
 * holding the event loop open at quit.
 *
 * Emits `(granted: boolean)` ONLY on transitions, with the new value. The
 * baseline is read at construction time; the first `onChange` invocation
 * arrives after the first transition the watcher observes — callers
 * should seed initial state via `current()` or `platform.permissions.read`.
 */

import { systemPreferences } from 'electron';

const DEFAULT_POLL_MS = 1500;

export class AccessibilityWatcher {
  private timer: NodeJS.Timeout | null = null;
  private listeners: Set<(granted: boolean) => void> = new Set();
  private lastGranted: boolean;
  private readonly pollMs: number;

  constructor(opts?: { pollMs?: number }) {
    this.pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;
    this.lastGranted = readTrust();
  }

  /** Most recent observed grant. Cheap; doesn't poll. */
  current(): boolean {
    return this.lastGranted;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Subscribe to grant transitions. Returns unsubscribe. */
  onChange(cb: (granted: boolean) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private tick(): void {
    const granted = readTrust();
    if (granted === this.lastGranted) return;
    this.lastGranted = granted;
    for (const cb of this.listeners) {
      try {
        cb(granted);
      } catch {
        /* user callback; not our problem */
      }
    }
  }
}

function readTrust(): boolean {
  if (process.platform !== 'darwin') return true;
  try {
    return systemPreferences.isTrustedAccessibilityClient(false);
  } catch {
    // Defensive — Electron's API has historically been stable, but a failure
    // here shouldn't crash the watcher. Treat as "no change" (return the
    // status quo) by claiming granted; the caller's downstream guards
    // (the native AX recheck, libuiohook, CGEventPost no-op-when-untrusted)
    // are still in place.
    return true;
  }
}
