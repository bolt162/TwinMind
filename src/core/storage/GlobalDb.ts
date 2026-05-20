/**
 * GlobalDb — machine-wide SQLite store for user-management + wizard state.
 *
 * Architecture: multi-user data isolation. This database lives at
 * `<userData>/global.db` and holds three things that exist BEFORE we know
 * which user is active:
 *
 *   - `users`    — one row per user who has ever signed in on this machine,
 *                  including their encrypted refresh token (NULL when signed
 *                  out). Identity directory + credential anchor.
 *   - `wizard`   — singleton; tracks `onboarding_completed_at`. Permissions
 *                  are macOS-scoped, so the wizard is machine-scoped too —
 *                  any user signing in on a machine that already finished the
 *                  wizard skips it.
 *   - `active`   — singleton; pointer to the currently-active userId or NULL.
 *                  Lets `main.ts` resume the right per-user `ComposedApp` on
 *                  app restart without prompting for credentials again.
 *
 * Every per-user thing (sessions, chunks, transcripts, recordings, logs,
 * settings.json) lives under `<userData>/users/<slug>/` — see
 * `UserDataPaths.ts`. Crossing the boundary between this store and a user
 * store is always explicit and gated by an active userId.
 *
 * The migration runner (`Migrator.ts`) is reused; SQL is inlined for the
 * same reason `0001_initial.ts` inlines its SQL — bundler-stable bytes.
 */

import type { Database } from 'better-sqlite3';
import { prepareDatabase, type Migration } from './Migrator';
import type { Clock } from '@core/util/Clock';

// ─── Schema ─────────────────────────────────────────────────────────────────

const SQL_V1_GLOBAL_INITIAL = `
-- One row per user who has ever signed in on this machine. We keep rows
-- around even after sign-out so the welcome screen can offer "Continue as
-- <email>" without forcing a fresh OAuth dance. The refresh token column
-- is what actually flips with sign-in/sign-out — NULL means "needs to
-- authenticate again."
CREATE TABLE users (
  id                 TEXT PRIMARY KEY,        -- transformed_sub or Firebase localId
  email              TEXT NOT NULL,
  name               TEXT,
  photo_url          TEXT,
  last_signed_in_at  INTEGER NOT NULL,        -- epoch ms
  -- safeStorage-encrypted base64 blob. Cleared (NULL) on sign-out.
  refresh_token_enc  TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- Index for the "most-recent users" listing on the welcome screen.
CREATE INDEX idx_users_last_signed_in ON users(last_signed_in_at DESC);

-- Singleton row; CHECK forces id=1 so we can use UPSERT for set-once writes.
CREATE TABLE wizard (
  id                       INTEGER PRIMARY KEY CHECK(id = 1),
  onboarding_completed_at  INTEGER,           -- nullable; set once
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);
INSERT INTO wizard(id, onboarding_completed_at, created_at, updated_at)
  VALUES (1, NULL, unixepoch() * 1000, unixepoch() * 1000);

-- Singleton row; same CHECK pattern. \`active_user_id\` REFERENCES users(id)
-- with ON DELETE SET NULL so deleting a user (rare) doesn't orphan a
-- pointer to a missing row.
CREATE TABLE active (
  id              INTEGER PRIMARY KEY CHECK(id = 1),
  active_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at      INTEGER NOT NULL
);
INSERT INTO active(id, active_user_id, updated_at)
  VALUES (1, NULL, unixepoch() * 1000);

CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL
);
`;

/** Migrations applied to `global.db`. Keep ordered + append-only — same rules as the per-user app.db. */
export const GLOBAL_MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'global_initial', sql: SQL_V1_GLOBAL_INITIAL },
];

// ─── Public shape ───────────────────────────────────────────────────────────

/**
 * Sanitized view of a row in `users`. The encrypted refresh token is NEVER
 * returned via this shape — callers fetch it explicitly through
 * `getRefreshTokenEnc(userId)` so accidental log lines / IPC payloads can't
 * include it.
 */
export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly photoUrl: string | null;
  readonly lastSignedInAt: number;
  /** True iff `refresh_token_enc IS NOT NULL`. Surfaced for the welcome UI. */
  readonly hasRefreshToken: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Input to upsertUser; matches the auth-provider's post-sign-in shape. */
export interface UpsertUserInput {
  readonly id: string;
  readonly email: string;
  readonly name?: string | null;
  readonly photoUrl?: string | null;
  readonly signedInAt: number;
}

// ─── Class ──────────────────────────────────────────────────────────────────

/**
 * Thin repository over `global.db`. All writes use prepared statements; reads
 * never project the encrypted refresh token into a row shape.
 */
export class GlobalDb {
  /**
   * @param db    A better-sqlite3 Database already opened on the right file
   *              and pragmas applied via `prepareDatabase` (see `open` below).
   * @param clock Injected for tests; production wires `SystemClock`.
   */
  constructor(private readonly db: Database, private readonly clock: Clock) {}

  /** Convenience: open `<userDataDir>/global.db`, apply migrations, return a ready GlobalDb. */
  static open(dbFactory: () => Database, clock: Clock): GlobalDb {
    const db = dbFactory();
    prepareDatabase(db, GLOBAL_MIGRATIONS);
    return new GlobalDb(db, clock);
  }

  // ─── Active user ──────────────────────────────────────────────────────────

  /** The currently-active userId, or null if no one is signed in. */
  getActiveUserId(): string | null {
    const row = this.db.prepare('SELECT active_user_id FROM active WHERE id = 1').get() as
      | { active_user_id: string | null }
      | undefined;
    return row?.active_user_id ?? null;
  }

  /**
   * Set the active userId. Pass null on sign-out. Does NOT modify the users
   * table — `clearRefreshTokenEnc(userId)` is the separate intentional sign-out
   * step that revokes future auto-resume.
   */
  setActiveUserId(userId: string | null): void {
    this.db
      .prepare('UPDATE active SET active_user_id = ?, updated_at = ? WHERE id = 1')
      .run(userId, this.clock.now());
  }

  // ─── Users ────────────────────────────────────────────────────────────────

  /** Fetch a single user by id. */
  getUser(userId: string): UserRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, email, name, photo_url, last_signed_in_at,
                refresh_token_enc IS NOT NULL AS has_refresh_token,
                created_at, updated_at
         FROM users WHERE id = ?`,
      )
      .get(userId) as
      | {
          id: string;
          email: string;
          name: string | null;
          photo_url: string | null;
          last_signed_in_at: number;
          has_refresh_token: number;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    return row ? toUserRecord(row) : null;
  }

  /** Every user, most recently signed-in first. Used by the welcome screen. */
  listUsers(): UserRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, email, name, photo_url, last_signed_in_at,
                refresh_token_enc IS NOT NULL AS has_refresh_token,
                created_at, updated_at
         FROM users ORDER BY last_signed_in_at DESC`,
      )
      .all() as Array<{
      id: string;
      email: string;
      name: string | null;
      photo_url: string | null;
      last_signed_in_at: number;
      has_refresh_token: number;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map(toUserRecord);
  }

  /**
   * Insert or update a user row. Idempotent on repeated calls with the same
   * id — used by every successful sign-in to bump `last_signed_in_at` and
   * refresh display info (name / photo) from the latest Google profile.
   * Does NOT touch `refresh_token_enc`; that's a separate explicit write.
   */
  upsertUser(input: UpsertUserInput): void {
    const now = this.clock.now();
    this.db
      .prepare(
        `INSERT INTO users (id, email, name, photo_url, last_signed_in_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           email             = excluded.email,
           name              = excluded.name,
           photo_url         = excluded.photo_url,
           last_signed_in_at = excluded.last_signed_in_at,
           updated_at        = excluded.updated_at`,
      )
      .run(
        input.id,
        input.email,
        input.name ?? null,
        input.photoUrl ?? null,
        input.signedInAt,
        now,
        now,
      );
  }

  /** Remove a user row entirely. Sets `active.active_user_id` to NULL via FK. */
  deleteUser(userId: string): void {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }

  // ─── Refresh token ────────────────────────────────────────────────────────

  /**
   * Returns the encrypted refresh-token blob for a user, or null. Caller
   * decrypts via `ISecureStorage.decrypt`. Throws if the user doesn't exist.
   */
  getRefreshTokenEnc(userId: string): string | null {
    const row = this.db
      .prepare('SELECT refresh_token_enc FROM users WHERE id = ?')
      .get(userId) as { refresh_token_enc: string | null } | undefined;
    if (!row) {
      throw new Error(`GlobalDb.getRefreshTokenEnc: user not found: ${userId}`);
    }
    return row.refresh_token_enc;
  }

  /**
   * Persist the encrypted refresh-token blob for an existing user. The blob
   * is always produced by `ISecureStorage.encrypt`; we don't validate it
   * here. Throws if the user row doesn't exist.
   */
  setRefreshTokenEnc(userId: string, enc: string): void {
    const r = this.db
      .prepare('UPDATE users SET refresh_token_enc = ?, updated_at = ? WHERE id = ?')
      .run(enc, this.clock.now(), userId);
    if (r.changes === 0) {
      throw new Error(`GlobalDb.setRefreshTokenEnc: user not found: ${userId}`);
    }
  }

  /** Clear the encrypted refresh-token blob for a user (sign-out). No-op if missing. */
  clearRefreshTokenEnc(userId: string): void {
    this.db
      .prepare('UPDATE users SET refresh_token_enc = NULL, updated_at = ? WHERE id = ?')
      .run(this.clock.now(), userId);
  }

  // ─── Wizard ───────────────────────────────────────────────────────────────

  /** Returns the timestamp when the onboarding wizard was first completed, or null. */
  getOnboardingCompletedAt(): number | null {
    const row = this.db
      .prepare('SELECT onboarding_completed_at FROM wizard WHERE id = 1')
      .get() as { onboarding_completed_at: number | null } | undefined;
    return row?.onboarding_completed_at ?? null;
  }

  /** Mark the wizard as completed now. Idempotent — overwrites with the latest timestamp. */
  setOnboardingCompletedAt(ts: number): void {
    this.db
      .prepare(
        'UPDATE wizard SET onboarding_completed_at = ?, updated_at = ? WHERE id = 1',
      )
      .run(ts, this.clock.now());
  }

  /** Clear the wizard-completed marker. Surface for tests / "reset onboarding" affordances. */
  clearOnboardingCompletedAt(): void {
    this.db
      .prepare(
        'UPDATE wizard SET onboarding_completed_at = NULL, updated_at = ? WHERE id = 1',
      )
      .run(this.clock.now());
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /** Close the underlying connection. App-shutdown only. */
  close(): void {
    this.db.close();
  }
}

function toUserRecord(row: {
  id: string;
  email: string;
  name: string | null;
  photo_url: string | null;
  last_signed_in_at: number;
  has_refresh_token: number;
  created_at: number;
  updated_at: number;
}): UserRecord {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    photoUrl: row.photo_url,
    lastSignedInAt: row.last_signed_in_at,
    hasRefreshToken: row.has_refresh_token === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
