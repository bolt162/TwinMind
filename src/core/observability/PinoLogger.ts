/**
 * PinoLogger — production Logger backed by pino + the Redactor.
 *
 * Architecture: §13.1 — JSON logs, daily rotation, ring buffer for Sentry
 * breadcrumbs. The rotation + ring buffer wiring lives in `composition.ts`
 * (pino destinations); this file is just the construction + redaction
 * serializer step.
 *
 * Redaction strategy: pino's built-in `redact.paths` doesn't run on free-form
 * string values, only on known field paths. We do TWO things:
 *   1. Use pino's redact for known sensitive paths (e.g. `headers.authorization`).
 *   2. Pre-serialize every log call through `redact()` from `Redactor.ts` so
 *      free-form strings (Bearer tokens in URLs, /Users/<name>/...) are
 *      scrubbed by regex.
 */

import pino, { type Logger as PinoBase, type LoggerOptions } from 'pino';
import { redact } from './Redactor';
import type { LogContext, LogLevel, Logger } from './Logger';

export interface PinoLoggerOptions {
  readonly level?: LogLevel;
  /** Optional file path; if absent, logs go to process.stdout. */
  readonly destination?: string;
  /** Set `false` to emit JSON (production); `true` adds pino-pretty. */
  readonly pretty?: boolean;
}

/** Build a Logger from `pino`. */
export function createPinoLogger(opts: PinoLoggerOptions = {}): Logger {
  const options: LoggerOptions = {
    level: opts.level ?? 'info',
    redact: {
      paths: [
        'apiKey',
        'api_key',
        'authorization',
        'token',
        'refresh_token',
        'password',
        'email',
        'headers.authorization',
        'headers["set-cookie"]',
      ],
      remove: false,
      censor: '<redacted>',
    },
    ...(opts.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss' },
          },
        }
      : {}),
  };
  const base = opts.destination
    ? pino(options, pino.destination({ dest: opts.destination, sync: false }))
    : pino(options);
  return wrap(base);
}

/** Wrap a pino instance to match our `Logger` interface + apply free-form redaction. */
function wrap(p: PinoBase): Logger {
  const log = (level: LogLevel, msg: string, ctx?: LogContext) => {
    const safeCtx = ctx ? (redact(ctx) as LogContext) : undefined;
    safeCtx ? p[level](safeCtx, msg) : p[level](msg);
  };
  return {
    trace: (m, c) => log('trace', m, c),
    debug: (m, c) => log('debug', m, c),
    info: (m, c) => log('info', m, c),
    warn: (m, c) => log('warn', m, c),
    error: (m, c) => log('error', m, c),
    child(bindings) {
      return wrap(p.child(redact(bindings) as LogContext));
    },
  };
}
