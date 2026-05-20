import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureUserTree,
  globalDbPath,
  legacyDir,
  userIdSlug,
  userPathsFor,
} from '@core/storage/UserDataPaths';

describe('UserDataPaths', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'twinmind-userpaths-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('userIdSlug', () => {
    it('passes through alphanumerics + _ . -', () => {
      expect(userIdSlug('abc123')).toBe('abc123');
      expect(userIdSlug('Abc_123-foo.bar')).toBe('Abc_123-foo.bar');
    });

    it('replaces pipes (Auth0-style userIds) with underscores', () => {
      expect(userIdSlug('auth0|abc123')).toBe('auth0_abc123');
    });

    it('replaces path separators with underscores so a userId cannot escape the user dir', () => {
      expect(userIdSlug('../etc/passwd')).toBe('_._etc_passwd');
      expect(userIdSlug('a/b\\c')).toBe('a_b_c');
    });

    it('refuses empty input', () => {
      expect(() => userIdSlug('')).toThrow(/empty userId/);
    });

    it('refuses input that sanitizes to dot-only', () => {
      // Defensive: ".." would have been mapped to "__" by the regex above
      // (dot is allowed), but a leading/trailing dot strip protects against
      // a userId being literally "." or "..".
      expect(() => userIdSlug('.')).toThrow(/invalid name/);
      expect(() => userIdSlug('..')).toThrow(/invalid name/);
    });

    it('is deterministic', () => {
      expect(userIdSlug('user|123')).toBe(userIdSlug('user|123'));
    });
  });

  describe('userPathsFor', () => {
    it('produces a full per-user layout rooted at users/<slug>', () => {
      const p = userPathsFor(root, 'abc123');
      expect(p.userDir).toBe(path.join(root, 'users', 'abc123'));
      expect(p.dbPath).toBe(path.join(root, 'users', 'abc123', 'app.db'));
      expect(p.recordingsDir).toBe(path.join(root, 'users', 'abc123', 'recordings'));
      expect(p.logsDir).toBe(path.join(root, 'users', 'abc123', 'logs'));
      expect(p.crashBundlesDir).toBe(path.join(root, 'users', 'abc123', 'crash-bundles'));
      expect(p.settingsDir).toBe(p.userDir);
    });

    it('routes Auth0-style userIds through the slug', () => {
      const p = userPathsFor(root, 'auth0|abc123');
      expect(p.userDir).toBe(path.join(root, 'users', 'auth0_abc123'));
    });
  });

  describe('globalDbPath / legacyDir', () => {
    it('puts global.db at the userData root', () => {
      expect(globalDbPath(root)).toBe(path.join(root, 'global.db'));
    });
    it('puts the legacy dir at the userData root', () => {
      expect(legacyDir(root)).toBe(path.join(root, 'legacy'));
    });
  });

  describe('ensureUserTree', () => {
    it('creates the per-user tree', () => {
      const p = userPathsFor(root, 'abc123');
      ensureUserTree(p);
      expect(fs.existsSync(p.userDir)).toBe(true);
      expect(fs.existsSync(p.recordingsDir)).toBe(true);
      expect(fs.existsSync(p.logsDir)).toBe(true);
      expect(fs.existsSync(p.crashBundlesDir)).toBe(true);
    });

    it('is idempotent', () => {
      const p = userPathsFor(root, 'abc123');
      ensureUserTree(p);
      ensureUserTree(p);
      expect(fs.existsSync(p.userDir)).toBe(true);
    });

    it('uses restrictive 0o700 mode on the user dir', () => {
      // Mode bits aren't preserved on Windows; only assert when the platform
      // honors them. macOS (the only supported deployment target today) does.
      if (process.platform === 'win32') return;
      const p = userPathsFor(root, 'abc123');
      ensureUserTree(p);
      const stat = fs.statSync(p.userDir);
      // The directory mode includes type bits (S_IFDIR); mask to the perm bits.
      expect(stat.mode & 0o777).toBe(0o700);
    });

    it('isolates two users into distinct trees', () => {
      const a = userPathsFor(root, 'userA');
      const b = userPathsFor(root, 'userB');
      ensureUserTree(a);
      ensureUserTree(b);
      // The two user dirs must be siblings, not nested.
      expect(a.userDir).not.toBe(b.userDir);
      expect(path.dirname(a.userDir)).toBe(path.dirname(b.userDir));
    });
  });
});
