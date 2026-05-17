/**
 * DarwinMicActivityMonitor — wraps the native addon's `micMonitor` export.
 *
 * Architecture: §8.1 — `kAudioDevicePropertyDeviceIsRunningSomewhere` on the
 * default input device. The addon's index.js exposes `started` / `stopped`
 * events; this adapter forwards them through the platform interface.
 *
 * Loading the addon throws (per the addon's index.js) if its native binary
 * isn't built. Composition should wrap construction in a try/catch so the
 * app falls back to no meeting auto-detect rather than failing to start.
 */

import type { IMicActivityMonitor } from '../IMicActivityMonitor';

interface NativeMicMonitor {
  start(): void;
  stop(): void;
  on(event: 'started' | 'stopped', cb: () => void): () => void;
}

export class DarwinMicActivityMonitor implements IMicActivityMonitor {
  private readonly inner: NativeMicMonitor;

  /** Construct over the addon's `micMonitor()` factory. */
  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const native = require('@twinmind/coreaudio-darwin') as {
      micMonitor: () => NativeMicMonitor;
    };
    this.inner = native.micMonitor();
  }

  start(): void {
    this.inner.start();
  }

  stop(): void {
    this.inner.stop();
  }

  onMicStarted(cb: () => void): () => void {
    return this.inner.on('started', cb);
  }

  onMicStopped(cb: () => void): () => void {
    return this.inner.on('stopped', cb);
  }
}
