/**
 * Minimal Logger interface — structural, so services can accept it as a dep
 * without pulling pino into tests.
 *
 * Architecture: §13.1 — the real Logger is a pino instance with the Redactor
 * (see Redactor.ts) attached as a serializer step and a ring buffer for Sentry
 * breadcrumbs. That wiring lives in `composition.ts`; this file is just the
 * shape that the rest of the code depends on.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/** Optional structured context object passed alongside each log message. */
export type LogContext = Record<string, unknown>;

export interface Logger {
  trace(msg: string, ctx?: LogContext): void;
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  /** Returns a child logger that injects `bindings` into every log line. */
  child(bindings: LogContext): Logger;
}

/** A logger that drops everything; safe default for services in tests. */
export const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};
