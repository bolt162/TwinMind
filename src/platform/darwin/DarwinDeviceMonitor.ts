/**
 * DarwinDeviceMonitor — default-input device-change observer.
 *
 * Architecture: §7.7 (device-change recovery). Two event sources fan into one
 * subscriber surface:
 *
 *   1. Native subscription to `kAudioHardwarePropertyDefaultInputDevice` via
 *      the `@twinmind/coreaudio-darwin` addon. Fires whenever the OS default
 *      input flips — works whether or not we're recording.
 *
 *   2. Forwarded `device_change` messages from the audio-process (which sees
 *      AVAudioEngineConfigurationChange while a capture is live). main.ts
 *      pipes these in via `emit()`.
 *
 * The two sources are intentionally overlapping; we dedupe by ignoring
 * duplicate label+kind events that arrive within `DEDUPE_WINDOW_MS` of each
 * other. The dedupe is "last event wins" — a more authoritative classification
 * from the native side overrides an audio-process placeholder.
 */

import type { DeviceChange, IDeviceMonitor } from '../IDeviceMonitor';
import { type Logger, noopLogger } from '@core/observability/Logger';

interface NativeDeviceMonitor {
  start(): void;
  stop(): void;
  on(event: 'change', cb: (info: DeviceChange) => void): () => void;
}

/** Drop a duplicate event arriving within this window of an identical one. */
const DEDUPE_WINDOW_MS = 500;

export class DarwinDeviceMonitor implements IDeviceMonitor {
  private readonly listeners = new Set<(c: DeviceChange) => void>();
  private running = false;
  private native: NativeDeviceMonitor | null = null;
  private nativeUnsubscribe: (() => void) | null = null;
  private lastEvent: DeviceChange | null = null;
  private lastEventAt = 0;

  constructor(private readonly logger: Logger = noopLogger) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const addon = require('@twinmind/coreaudio-darwin') as {
        deviceMonitor: () => NativeDeviceMonitor;
      };
      this.native = addon.deviceMonitor();
      this.nativeUnsubscribe = this.native.on('change', (info) => this.fanout(info));
      this.native.start();
    } catch (e) {
      this.logger.warn('native deviceMonitor unavailable; falling back to audio-process events', {
        err: e instanceof Error ? e.message : String(e),
      });
      this.native = null;
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.nativeUnsubscribe) {
      this.nativeUnsubscribe();
      this.nativeUnsubscribe = null;
    }
    if (this.native) {
      try {
        this.native.stop();
      } catch {
        /* best-effort */
      }
      this.native = null;
    }
  }

  /** Subscribe; returns unsubscribe. */
  onChange(cb: (change: DeviceChange) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Hook for main.ts to forward `device_change` AudioToMain messages.
   * Goes through the same dedupe + fanout path as native events.
   */
  emit(change: DeviceChange): void {
    if (!this.running) return;
    this.fanout(change);
  }

  /** Apply dedupe and broadcast to subscribers. */
  private fanout(change: DeviceChange): void {
    const now = Date.now();
    if (
      this.lastEvent &&
      now - this.lastEventAt < DEDUPE_WINDOW_MS &&
      this.lastEvent.label === change.label &&
      this.lastEvent.kind === change.kind &&
      this.lastEvent.noDevice === change.noDevice
    ) {
      return;
    }
    this.lastEvent = change;
    this.lastEventAt = now;
    for (const cb of this.listeners) {
      try {
        cb(change);
      } catch (e) {
        this.logger.error('deviceMonitor listener threw', {
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
}
