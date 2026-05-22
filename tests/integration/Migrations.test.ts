import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { MIGRATIONS } from '@core/storage/migrations';
import {
  getDbVersion,
  prepareDatabase,
  runMigrations,
  SchemaDowngradeError,
} from '@core/storage/Migrator';

describe('Migrations', () => {
  let db: Database.Database;
  // The schema's latest version — derived from the migration registry so we
  // don't have to update these tests every time a new migration is added.
  const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  it('applies the initial migration on a fresh DB', () => {
    expect(getDbVersion(db)).toBe(0);
    prepareDatabase(db, MIGRATIONS);
    expect(getDbVersion(db)).toBe(LATEST_VERSION);

    // schema_migrations records every applied migration, not just the latest.
    const rows = db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number }>;
    expect(rows.map((r) => r.version)).toEqual(MIGRATIONS.map((m) => m.version));

    // Schema is queryable: required tables exist.
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'sessions',
        'chunks',
        'transcripts',
        'mic_activity_events',
        'kv',
        'schema_migrations',
      ]),
    );
  });

  it('is idempotent — second apply is a no-op', () => {
    prepareDatabase(db, MIGRATIONS);
    prepareDatabase(db, MIGRATIONS);
    expect(getDbVersion(db)).toBe(LATEST_VERSION);

    // Each migration applied exactly once across both prepareDatabase calls.
    const count = (
      db.prepare('SELECT COUNT(*) as n FROM schema_migrations').get() as { n: number }
    ).n;
    expect(count).toBe(MIGRATIONS.length);
  });

  it('throws SchemaDowngradeError when DB is ahead of app', () => {
    // Simulate a future version: bump user_version manually.
    db.pragma('user_version = 99');
    expect(() => runMigrations(db, MIGRATIONS)).toThrow(SchemaDowngradeError);
  });

  it('rejects ill-ordered migrations', () => {
    const bad = [
      { version: 1, name: 'a', sql: 'CREATE TABLE a(x INT)' },
      { version: 1, name: 'b', sql: 'CREATE TABLE b(x INT)' },
    ];
    expect(() => runMigrations(db, bad)).toThrow(/out of order/);
  });
});
