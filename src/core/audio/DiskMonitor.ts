/**
 * DiskMonitor — polls free disk space and emits warn / stop events.
 *
 * Architecture: §7.6 — at <2 GB free emit `warn`; at <200 MB emit `stop`
 * (orchestrator force-stops the session with `end_reason='disk_full'`).
 *
 * Implementation: `fs.statfsSync(userDataDir)` returns block counts; multiply
 * by the block size to get bytes. We poll every 30 s while running, plus once
 * at start. The poll is cheap on macOS (no permission needed).
 */

import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { type Logger, noopLogger } from '@core/observability/Logger';

export const DISK_WARN_FREE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
export const DISK_STOP_FREE_BYTES = 200 * 1024 * 1024; // 200 MB
const POLL_INTERVAL_MS = 30_000;

export interface DiskWarnEvent {
  readonly freeBytes: number;
}
export interface DiskStopEvent {
  readonly freeBytes: number;
}

export interface DiskMonitorDeps {
  readonly dir: string;
  /** Optional override; defaults to fs.statfsSync — tests pass a fake. */
  readonly statfs?: (path: string) => { bavail: bigint; bsize: number };
  readonly logger?: Logger;
}

export class DiskMonitor {
  private readonly emitter = new EventEmitter();
  private readonly statfs: (path: string) => { bavail: bigint; bsize: number };
  private readonly logger: Logger;
  private timer: NodeJS.Timeout | null = null;

  /** Construct with deps; does not start polling until `start()`. */
  constructor(private readonly deps: DiskMonitorDeps) {
    this.statfs = deps.statfs ?? defaultStatfs;
    this.logger = deps.logger ?? noopLogger;
  }

  /** Begin polling; fires once immediately so first-tick warn/stop is timely. */
  start(): void {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  /** Stop polling. Idempotent. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Subscribe to "low disk" warnings. */
  onWarn(cb: (e: DiskWarnEvent) => void): () => void {
    this.emitter.on('warn', cb);
    return () => this.emitter.off('warn', cb);
  }

  /** Subscribe to "stop now" events (forces the orchestrator to end the session). */
  onStop(cb: (e: DiskStopEvent) => void): () => void {
    this.emitter.on('stop', cb);
    return () => this.emitter.off('stop', cb);
  }

  /** One poll tick. Public for tests. */
  poll(): void {
    let bytes: number;
    try {
      const r = this.statfs(this.deps.dir);
      // bavail can be a bigint (Node 22+); coerce to number — even a 2 PB free
      // space fits in JS Number.MAX_SAFE_INTEGER (9 PB).
      bytes = Number(r.bavail) * r.bsize;
    } catch (err) {
      this.logger.warn('statfs failed', { err: String(err) });
      return;
    }
    if (bytes < DISK_STOP_FREE_BYTES) {
      this.emitter.emit('stop', { freeBytes: bytes } satisfies DiskStopEvent);
      return;
    }
    if (bytes < DISK_WARN_FREE_BYTES) {
      this.emitter.emit('warn', { freeBytes: bytes } satisfies DiskWarnEvent);
    }
  }
}

/** Node-native statfs reader returning the two fields we use. */
function defaultStatfs(path: string): { bavail: bigint; bsize: number } {
  // BigInt mode is required to avoid silent overflow on very large volumes.
  const r = fs.statfsSync(path, { bigint: true });
  return { bavail: r.bavail, bsize: Number(r.bsize) };
}
