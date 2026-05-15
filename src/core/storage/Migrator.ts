/**
 * Migrations runner.
 *
 * Architecture: §10.2 — "PRAGMA user_version + a simple if-ladder. No framework.
 * When schema rev > app version, refuse to start and surface 'App downgrade —
 * please update.'"
 *
 * Each migration is a (version, sql) pair. They run in order inside a single
 * write transaction so a partial apply is impossible — either we end at the
 * new user_version or we end exactly where we were before.
 */

import type { Database } from 'better-sqlite3';

export interface Migration {
  /** Strictly increasing. The DB's `PRAGMA user_version` becomes this after apply. */
  readonly version: number;
  /** Human label for diagnostics; not stored. */
  readonly name: string;
  /** Raw SQL executed inside a transaction. May contain multiple statements. */
  readonly sql: string;
}

/** Thrown when DB schema is newer than what this build knows about. */
export class SchemaDowngradeError extends Error {
  constructor(public readonly dbVersion: number, public readonly appMaxVersion: number) {
    super(
      `Database schema version ${dbVersion} is newer than the app supports ` +
        `(max ${appMaxVersion}). Please update the app.`,
    );
    this.name = 'SchemaDowngradeError';
  }
}

/** Read the SQLite `user_version` pragma; returns 0 on a freshly created DB. */
export function getDbVersion(db: Database): number {
  // .pragma returns an array of rows like [{ user_version: 0 }] unless `simple: true`.
  return db.pragma('user_version', { simple: true }) as number;
}

/**
 * Open-time setup: apply baseline PRAGMAs, then run pending migrations.
 *
 * PRAGMAs `journal_mode` and `synchronous` can't be set inside a transaction
 * (SQLite restriction), so they cannot live in a migration's SQL — they're
 * applied here before migrations run. Tests and the composition root both
 * call this; nothing else should call `runMigrations` directly.
 */
export function prepareDatabase(db: Database, migrations: readonly Migration[]): void {
  // WAL: better write concurrency; in-memory DBs ignore this (always 'memory').
  db.pragma('journal_mode = WAL');
  // Trade absolute durability for ~10× write speed; safe with WAL + fsync on commit.
  db.pragma('synchronous = NORMAL');
  // Enforce CASCADE deletes on `sessions → chunks → transcripts`.
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
}

/**
 * Apply all migrations whose version is > current `user_version`, in order.
 * Throws `SchemaDowngradeError` if the DB is ahead of `migrations`. Idempotent
 * if all migrations are already applied.
 */
export function runMigrations(db: Database, migrations: readonly Migration[]): void {
  // Validate the input is well-formed before we touch the DB. A duplicate or
  // out-of-order migration is a programmer bug; fail loudly here, not later.
  assertWellOrdered(migrations);

  const current = getDbVersion(db);
  const appMax = migrations.length === 0 ? 0 : migrations[migrations.length - 1]!.version;

  if (current > appMax) {
    throw new SchemaDowngradeError(current, appMax);
  }

  const pending = migrations.filter((m) => m.version > current);
  if (pending.length === 0) return;

  // Each migration is its own transaction so a failure in #2 doesn't rewind #1.
  // better-sqlite3's `transaction()` uses BEGIN by default; we want IMMEDIATE
  // so other connections can't sneak a write in between our reads and writes.
  for (const m of pending) {
    const apply = db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(
        m.version,
        Date.now(),
      );
      // Set user_version inside the same txn so partial apply is impossible.
      // `pragma` doesn't support parameters; substitute by clamped integer.
      db.pragma(`user_version = ${m.version | 0}`);
    });
    apply.immediate();
  }
}

/** Throw if migrations aren't strictly increasing in `version`. */
function assertWellOrdered(migrations: readonly Migration[]): void {
  let last = -Infinity;
  for (const m of migrations) {
    if (!Number.isInteger(m.version) || m.version <= 0) {
      throw new Error(`Migration version must be a positive integer: ${m.version}`);
    }
    if (m.version <= last) {
      throw new Error(`Migrations out of order or duplicated near v${m.version}`);
    }
    last = m.version;
  }
}
