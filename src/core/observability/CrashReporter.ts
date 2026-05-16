/**
 * CrashReporter — Sentry init (opt-in).
 *
 * Architecture: §13.2 — `@sentry/electron` for native + JS crashes, symbol
 * uploads in CI, breadcrumbs from logger ring buffer.
 *
 * Opt-in via env: `TWINMIND_SENTRY_DSN`. Without it, this module is a no-op
 * so dev builds don't accidentally ping someone's Sentry quota.
 */

import { type Logger, noopLogger } from './Logger';

export interface CrashReporterDeps {
  readonly dsn: string | null;
  readonly release: string;
  /** 'main' or 'renderer' — Sentry needs to know which process initialized. */
  readonly scope: 'main' | 'renderer';
  readonly logger?: Logger;
}

export interface ICrashReporter {
  init(): void;
  captureException(err: unknown, ctx?: Record<string, unknown>): void;
  setTag(key: string, value: string): void;
}

/** The no-op reporter; used when `dsn` is absent. */
export const noopCrashReporter: ICrashReporter = {
  init: () => {},
  captureException: () => {},
  setTag: () => {},
};

/**
 * Build a Sentry reporter if a DSN is configured; otherwise return the no-op.
 * Wrapping the require in a function keeps tests + dev unaware of Sentry's
 * heavy SDK unless it's actually wired.
 */
export function buildCrashReporter(deps: CrashReporterDeps): ICrashReporter {
  if (!deps.dsn) return noopCrashReporter;
  const log = deps.logger ?? noopLogger;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Sentry = require('@sentry/electron/main') as {
      init: (opts: { dsn: string; release: string }) => void;
      captureException: (err: unknown, opts?: { extra?: Record<string, unknown> }) => void;
      setTag: (key: string, value: string) => void;
    };
    let initialized = false;
    return {
      init() {
        if (initialized) return;
        Sentry.init({ dsn: deps.dsn!, release: deps.release });
        initialized = true;
      },
      captureException(err, ctx) {
        if (!initialized) return;
        Sentry.captureException(err, ctx ? { extra: ctx } : undefined);
      },
      setTag(key, value) {
        if (!initialized) return;
        Sentry.setTag(key, value);
      },
    };
  } catch (err) {
    log.warn('@sentry/electron unavailable; crash reporting disabled', {
      err: err instanceof Error ? err.message : String(err),
    });
    return noopCrashReporter;
  }
}
