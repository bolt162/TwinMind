import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { GlobalDb, GLOBAL_MIGRATIONS } from '@core/storage/GlobalDb';
import { prepareDatabase, getDbVersion } from '@core/storage/Migrator';
import { FakeClock } from '@core/util/Clock';

function setup() {
  const db = new Database(':memory:');
  prepareDatabase(db, GLOBAL_MIGRATIONS);
  const clock = new FakeClock(1_700_000_000_000);
  const store = new GlobalDb(db, clock);
  return { db, clock, store };
}

describe('GlobalDb — schema', () => {
  it('applies the initial migration', () => {
    const { db } = setup();
    expect(getDbVersion(db)).toBe(1);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining(['users', 'wizard', 'active', 'schema_migrations']),
    );
  });

  it('seeds the wizard + active singletons on initial migration', () => {
    const { store } = setup();
    expect(store.getOnboardingCompletedAt()).toBeNull();
    expect(store.getActiveUserId()).toBeNull();
  });

  it('is idempotent — re-running prepareDatabase is a no-op', () => {
    const { db } = setup();
    prepareDatabase(db, GLOBAL_MIGRATIONS);
    expect(getDbVersion(db)).toBe(1);
  });
});

describe('GlobalDb — users', () => {
  it('upsertUser inserts and round-trips through getUser', () => {
    const { store, clock } = setup();
    store.upsertUser({
      id: 'abc123',
      email: 'alice@example.com',
      name: 'Alice',
      photoUrl: 'https://lh3/abc=s400',
      signedInAt: clock.now(),
    });
    const u = store.getUser('abc123');
    expect(u).toMatchObject({
      id: 'abc123',
      email: 'alice@example.com',
      name: 'Alice',
      photoUrl: 'https://lh3/abc=s400',
      lastSignedInAt: clock.now(),
      hasRefreshToken: false,
    });
  });

  it('upsertUser on conflict updates email/name/photo/lastSignedInAt but not refresh token', () => {
    const { store, clock } = setup();
    store.upsertUser({
      id: 'abc123',
      email: 'old@example.com',
      name: 'Old',
      photoUrl: null,
      signedInAt: clock.now(),
    });
    store.setRefreshTokenEnc('abc123', 'enc-blob-v1');
    clock.advance(60_000);
    store.upsertUser({
      id: 'abc123',
      email: 'new@example.com',
      name: 'New',
      photoUrl: 'https://lh3/new=s400',
      signedInAt: clock.now(),
    });
    const u = store.getUser('abc123');
    expect(u?.email).toBe('new@example.com');
    expect(u?.name).toBe('New');
    expect(u?.photoUrl).toBe('https://lh3/new=s400');
    expect(u?.lastSignedInAt).toBe(clock.now());
    // Refresh token is intentionally untouched by upsert.
    expect(store.getRefreshTokenEnc('abc123')).toBe('enc-blob-v1');
  });

  it('getUser returns null for unknown ids', () => {
    const { store } = setup();
    expect(store.getUser('nope')).toBeNull();
  });

  it('listUsers orders most-recently-signed-in first', () => {
    const { store, clock } = setup();
    store.upsertUser({ id: 'a', email: 'a@x', signedInAt: 100 });
    clock.advance(1);
    store.upsertUser({ id: 'b', email: 'b@x', signedInAt: 300 });
    clock.advance(1);
    store.upsertUser({ id: 'c', email: 'c@x', signedInAt: 200 });
    const ids = store.listUsers().map((u) => u.id);
    expect(ids).toEqual(['b', 'c', 'a']);
  });

  it('hasRefreshToken reflects the encrypted-blob column', () => {
    const { store, clock } = setup();
    store.upsertUser({ id: 'a', email: 'a@x', signedInAt: clock.now() });
    expect(store.getUser('a')?.hasRefreshToken).toBe(false);
    store.setRefreshTokenEnc('a', 'enc-payload');
    expect(store.getUser('a')?.hasRefreshToken).toBe(true);
    store.clearRefreshTokenEnc('a');
    expect(store.getUser('a')?.hasRefreshToken).toBe(false);
  });

  it('deleteUser removes the row and clears the active pointer via FK', () => {
    const { store, clock } = setup();
    store.upsertUser({ id: 'a', email: 'a@x', signedInAt: clock.now() });
    store.setActiveUserId('a');
    expect(store.getActiveUserId()).toBe('a');
    store.deleteUser('a');
    expect(store.getUser('a')).toBeNull();
    expect(store.getActiveUserId()).toBeNull();
  });
});

describe('GlobalDb — refresh token isolation', () => {
  it('setting user B\'s token does not touch user A\'s', () => {
    const { store, clock } = setup();
    store.upsertUser({ id: 'a', email: 'a@x', signedInAt: clock.now() });
    store.upsertUser({ id: 'b', email: 'b@x', signedInAt: clock.now() });
    store.setRefreshTokenEnc('a', 'A-secret');
    store.setRefreshTokenEnc('b', 'B-secret');
    expect(store.getRefreshTokenEnc('a')).toBe('A-secret');
    expect(store.getRefreshTokenEnc('b')).toBe('B-secret');
    store.clearRefreshTokenEnc('b');
    expect(store.getRefreshTokenEnc('a')).toBe('A-secret');
    expect(store.getRefreshTokenEnc('b')).toBeNull();
  });

  it('setRefreshTokenEnc on a missing user throws', () => {
    const { store } = setup();
    expect(() => store.setRefreshTokenEnc('ghost', 'enc')).toThrow(/user not found/);
  });

  it('getRefreshTokenEnc on a missing user throws (no silent null)', () => {
    const { store } = setup();
    expect(() => store.getRefreshTokenEnc('ghost')).toThrow(/user not found/);
  });

  it('clearRefreshTokenEnc on a missing user is a no-op', () => {
    const { store } = setup();
    expect(() => store.clearRefreshTokenEnc('ghost')).not.toThrow();
  });
});

describe('GlobalDb — active pointer', () => {
  it('starts null; can be set and cleared', () => {
    const { store, clock } = setup();
    expect(store.getActiveUserId()).toBeNull();
    store.upsertUser({ id: 'a', email: 'a@x', signedInAt: clock.now() });
    store.setActiveUserId('a');
    expect(store.getActiveUserId()).toBe('a');
    store.setActiveUserId(null);
    expect(store.getActiveUserId()).toBeNull();
  });

  it('switching active from A to B does not leak refresh tokens', () => {
    const { store, clock } = setup();
    store.upsertUser({ id: 'a', email: 'a@x', signedInAt: clock.now() });
    store.upsertUser({ id: 'b', email: 'b@x', signedInAt: clock.now() });
    store.setRefreshTokenEnc('a', 'A-secret');
    store.setRefreshTokenEnc('b', 'B-secret');
    store.setActiveUserId('a');
    store.setActiveUserId('b');
    // Switching the pointer must NOT modify either token.
    expect(store.getRefreshTokenEnc('a')).toBe('A-secret');
    expect(store.getRefreshTokenEnc('b')).toBe('B-secret');
  });
});

describe('GlobalDb — wizard', () => {
  it('starts null', () => {
    const { store } = setup();
    expect(store.getOnboardingCompletedAt()).toBeNull();
  });

  it('set / get / clear round-trip', () => {
    const { store, clock } = setup();
    store.setOnboardingCompletedAt(clock.now());
    expect(store.getOnboardingCompletedAt()).toBe(clock.now());
    store.clearOnboardingCompletedAt();
    expect(store.getOnboardingCompletedAt()).toBeNull();
  });

  it('persists across reopens of the same DB', () => {
    // better-sqlite3 :memory: dies when the handle closes, so use a Buffer-backed
    // approach: re-instantiate GlobalDb over the same db handle to confirm
    // the value is in the table, not in some in-process cache.
    const { db, store, clock } = setup();
    store.setOnboardingCompletedAt(clock.now());
    const store2 = new GlobalDb(db, clock);
    expect(store2.getOnboardingCompletedAt()).toBe(clock.now());
  });
});
