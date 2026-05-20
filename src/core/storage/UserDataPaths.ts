/**
 * UserDataPaths — single source of truth for per-user filesystem layout.
 *
 * Architecture: multi-user data isolation. Each authenticated user gets their
 * own subtree under `<userData>/users/<slug>/` so there is no code path where
 * one user's DB handle, recording file, or log line can leak into another's
 * session. The slug is a sanitized form of the auth-provider userId so the
 * directory name is filesystem-safe (avoids `|`, `/`, control chars, etc.).
 *
 * Pure helper — no I/O except for `ensureUserTree`, which mkdirs with mode
 * 0o700 to match the conventions used in composition.ts for `recordings/` and
 * `logs/`. All other functions are path joins.
 *
 * Layout:
 *   <userData>/
 *     global.db                           ← machine-wide; user-management + wizard
 *     legacy/                             ← pre-multi-user data, if any
 *     users/<slug>/
 *       app.db
 *       settings.json
 *       recordings/
 *       logs/
 *       crash-bundles/
 */

import fs from 'node:fs';
import path from 'node:path';

/** Bundle of every path a single user's data lives at. */
export interface UserPaths {
  /** The user's per-user root: `<userData>/users/<slug>`. */
  readonly userDir: string;
  /** `<userDir>/app.db`. */
  readonly dbPath: string;
  /** `<userDir>/settings.json`. */
  readonly settingsDir: string;
  /** `<userDir>/recordings`. */
  readonly recordingsDir: string;
  /** `<userDir>/logs`. */
  readonly logsDir: string;
  /** `<userDir>/crash-bundles`. */
  readonly crashBundlesDir: string;
}

/**
 * Sanitize a userId for use as a filesystem path component. Allowed:
 * `[A-Za-z0-9_.-]`. Everything else becomes `_`. Idempotent and stable —
 * the same input always maps to the same output.
 *
 * The original userId is preserved in `global.db.users.id`; this slug is
 * only used for directory naming. Real-world Firebase `localId` values are
 * alphanumeric and pass through unchanged; the sanitization exists to
 * defend against `transformed_sub` values that look like `auth0|abc123`.
 */
export function userIdSlug(userId: string): string {
  if (userId.length === 0) {
    throw new Error('userIdSlug: empty userId');
  }
  // Strip leading/trailing dots so we never produce '.' or '..' as a dir name.
  const sanitized = userId.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+|\.+$/g, '_');
  if (sanitized.length === 0 || sanitized === '.' || sanitized === '..') {
    throw new Error(`userIdSlug: userId sanitizes to invalid name: ${JSON.stringify(userId)}`);
  }
  return sanitized;
}

/** Absolute path to `global.db` under the userData root. */
export function globalDbPath(userDataDir: string): string {
  return path.join(userDataDir, 'global.db');
}

/** Absolute path to the legacy-migration holding directory. */
export function legacyDir(userDataDir: string): string {
  return path.join(userDataDir, 'legacy');
}

/** Compute every per-user path from a userData root + userId. */
export function userPathsFor(userDataDir: string, userId: string): UserPaths {
  const slug = userIdSlug(userId);
  const userDir = path.join(userDataDir, 'users', slug);
  return {
    userDir,
    dbPath: path.join(userDir, 'app.db'),
    settingsDir: userDir,
    recordingsDir: path.join(userDir, 'recordings'),
    logsDir: path.join(userDir, 'logs'),
    crashBundlesDir: path.join(userDir, 'crash-bundles'),
  };
}

/**
 * Create the per-user directory tree with mode 0o700 (user-only access).
 * Idempotent — re-running is a no-op. Does NOT create the DB file itself;
 * better-sqlite3 does that when it opens the path.
 */
export function ensureUserTree(paths: UserPaths): void {
  for (const dir of [
    paths.userDir,
    paths.recordingsDir,
    paths.logsDir,
    paths.crashBundlesDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}
