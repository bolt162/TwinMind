/**
 * TwinMindAuthProvider integration tests.
 *
 * Uses a real in-memory SQLite GlobalDb (so the persistence path is
 * exercised end-to-end) but stubs everything network/OS-level:
 *   - secureStorage: base64 round-trip; no Keychain.
 *   - fetch: a small queueable mock.
 *   - runOAuthFlow: returns canned Google tokens without opening a browser.
 *   - timers: no-op so background ticks don't race the test.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { GlobalDb, GLOBAL_MIGRATIONS } from '@core/storage/GlobalDb';
import { prepareDatabase } from '@core/storage/Migrator';
import { FakeClock } from '@core/util/Clock';
import type { ISecureStorage } from '@platform/ISecureStorage';
import {
  TwinMindAuthProvider,
  type TwinMindAuthProviderDeps,
} from '@core/auth/TwinMindAuthProvider';
import type { ConfigResolution } from '@core/auth/twinmindBackendConfig';

// ─── Helpers ────────────────────────────────────────────────────────────────

const TEST_CONFIG: ConfigResolution = {
  ok: true,
  config: {
    firebaseWebApiKey: 'AIza-test',
    firebaseTenantId: 'TestTenant',
    firebaseProjectId: 'test-proj',
    googleOAuthClientId: '123.apps.googleusercontent.com',
    backendUrl: 'https://api.example',
    vercelProtectionBypass: 'bypass',
    transcribeUrl: 'https://api.example/api/v2/transcribe',
    summaryUrl: 'https://api.example/api/v2/summary',
    appUrl: 'https://app.example',
    dictationModel: 'twinmind-fast',
    meetingModel: 'twinmind-pro',
  },
};

class StubSecureStorage implements ISecureStorage {
  isAvailable(): boolean {
    return true;
  }
  encrypt(plain: string): string {
    return Buffer.from(`ENC:${plain}`).toString('base64');
  }
  decrypt(enc: string): string {
    const decoded = Buffer.from(enc, 'base64').toString('utf8');
    if (!decoded.startsWith('ENC:')) throw new Error('bad blob');
    return decoded.slice(4);
  }
}

interface QueuedResponse {
  match: (url: string, init?: RequestInit) => boolean;
  status: number;
  body: unknown;
}

class MockFetch {
  private queue: QueuedResponse[] = [];
  public calls: Array<{ url: string; init?: RequestInit }> = [];

  /** Convenience: match by URL substring. */
  enqueueOnce(urlSubstr: string, status: number, body: unknown): void {
    this.queue.push({
      match: (url) => url.includes(urlSubstr),
      status,
      body,
    });
  }

  fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    this.calls.push({ url, init });
    const idx = this.queue.findIndex((q) => q.match(url, init));
    if (idx === -1) {
      throw new Error(`MockFetch: no queued response for ${url}`);
    }
    const r = this.queue.splice(idx, 1)[0]!;
    const body =
      typeof r.body === 'string'
        ? r.body
        : r.body === undefined
          ? ''
          : JSON.stringify(r.body);
    return new Response(body, { status: r.status });
  };
}

function setup(opts: { configResolution?: ConfigResolution } = {}) {
  const db = new Database(':memory:');
  prepareDatabase(db, GLOBAL_MIGRATIONS);
  const clock = new FakeClock(1_700_000_000_000);
  const globalDb = new GlobalDb(db, clock);
  const secure = new StubSecureStorage();
  const mock = new MockFetch();

  const deps: TwinMindAuthProviderDeps = {
    configResolution: opts.configResolution ?? TEST_CONFIG,
    globalDb,
    secureStorage: secure,
    clock,
    fetchImpl: mock.fetch,
    openBrowser: async () => {
      /* never called when runOAuthFlow is overridden */
    },
    runOAuthFlow: async () => ({
      code: 'AUTH_CODE',
      idToken: 'GOOGLE_ID_TOKEN',
      redirectUri: 'http://127.0.0.1:3000/auth/callback',
    }),
    timers: {
      setInterval: () => 0 as unknown as NodeJS.Timeout,
      clearInterval: () => {},
    },
  };
  const provider = new TwinMindAuthProvider(deps);
  return { db, clock, globalDb, secure, mock, provider };
}

/**
 * Canned Firebase signInWithIdp response. The `idToken` has a real JWT shape
 * so `extractTransformedSub` doesn't blow up — payload is base64url JSON.
 */
function firebaseSignInResponse(over: Partial<Record<string, unknown>> = {}) {
  return {
    idToken: makeJwt({ sub: 'firebase-uid-1', email: 'alice@example.com' }),
    refreshToken: 'REFRESH_1',
    expiresIn: '3600',
    localId: 'firebase-uid-1',
    email: 'alice@example.com',
    displayName: 'Alice',
    rawUserInfo: JSON.stringify({
      name: 'Alice Example',
      picture: 'https://lh3.googleusercontent.com/abc=s96',
    }),
    ...over,
  };
}

function firebaseRefreshResponse(idToken = 'NEW_ACCESS', refresh = 'REFRESH_2') {
  return {
    id_token: idToken,
    refresh_token: refresh,
    expires_in: '3600',
    user_id: 'firebase-uid-1',
  };
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from('{"alg":"none"}').toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.`;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('TwinMindAuthProvider — initial state', () => {
  it('starts unauthenticated when the DB is empty', async () => {
    const { provider } = setup();
    await provider.initialize();
    expect(provider.isAuthenticated()).toBe(false);
    expect(provider.getViewState().user).toBeNull();
  });

  it('reports config missing in the view when env is incomplete', async () => {
    const { provider } = setup({
      configResolution: { ok: false, missing: ['FIREBASE_WEB_API_KEY'] },
    });
    await provider.initialize();
    expect(provider.getViewState().configMissing).toEqual(['FIREBASE_WEB_API_KEY']);
  });
});

describe('TwinMindAuthProvider — signIn', () => {
  it('persists user + encrypted refresh, sets active, fires state change', async () => {
    const { provider, globalDb, mock, secure } = setup();
    await provider.initialize();

    const changes: Array<{ userId: string | null }> = [];
    provider.onAuthChange((s) => changes.push(s));

    mock.enqueueOnce('signInWithIdp', 200, firebaseSignInResponse());
    mock.enqueueOnce('/api/v2/google-oauth', 200, { picture: 'pic' });

    const result = await provider.signIn();
    expect(result.ok).toBe(true);
    expect(provider.isAuthenticated()).toBe(true);
    expect(globalDb.getActiveUserId()).toBe('firebase-uid-1');

    // Refresh token is stored encrypted.
    const enc = globalDb.getRefreshTokenEnc('firebase-uid-1');
    expect(enc).not.toBeNull();
    expect(secure.decrypt(enc!)).toBe('REFRESH_1');

    // State change fired.
    expect(changes.at(-1)?.userId).toBe('firebase-uid-1');
  });

  it('returns config_missing when env is incomplete', async () => {
    const { provider } = setup({
      configResolution: { ok: false, missing: ['FIREBASE_WEB_API_KEY'] },
    });
    await provider.initialize();
    const r = await provider.signIn();
    expect(r.ok).toBe(false);
    expect(r.error).toBe('config_missing');
  });

  it('classifies user cancellation as `cancelled`', async () => {
    const { provider } = setup();
    // Override runOAuthFlow to simulate the loopback's timeout.
    (provider as unknown as { runOAuthFlow: () => Promise<never> }).runOAuthFlow = async () => {
      throw new Error('OAuth flow timed out');
    };
    await provider.initialize();
    const r = await provider.signIn();
    expect(r.ok).toBe(false);
    expect(r.error).toBe('cancelled');
  });

  it('treats backend POST failure as non-fatal', async () => {
    const { provider, mock } = setup();
    await provider.initialize();
    mock.enqueueOnce('signInWithIdp', 200, firebaseSignInResponse());
    mock.enqueueOnce('/api/v2/google-oauth', 500, { error: 'oops' });
    const r = await provider.signIn();
    expect(r.ok).toBe(true);
    expect(provider.isAuthenticated()).toBe(true);
  });

  it('uses transformed_sub for userId when present in the Firebase ID token', async () => {
    const { provider, mock, globalDb } = setup();
    await provider.initialize();
    const idTok = makeJwt({
      sub: 'firebase-uid-1',
      transformed_sub: 'auth0|abc123',
      email: 'alice@example.com',
    });
    mock.enqueueOnce('signInWithIdp', 200, firebaseSignInResponse({ idToken: idTok }));
    mock.enqueueOnce('/api/v2/google-oauth', 200, {});
    await provider.signIn();
    expect(provider.getState().userId).toBe('auth0|abc123');
    // And the DB stores it under that id.
    expect(globalDb.getUser('auth0|abc123')).not.toBeNull();
  });
});

describe('TwinMindAuthProvider — initialize with stored user', () => {
  it('rehydrates from GlobalDb and mints an access token on first refresh', async () => {
    const { provider, globalDb, mock, secure, clock } = setup();
    // Pre-populate as if a previous session had signed in.
    globalDb.upsertUser({ id: 'u', email: 'u@x', signedInAt: clock.now() });
    globalDb.setRefreshTokenEnc('u', secure.encrypt('REFRESH_X'));
    globalDb.setActiveUserId('u');

    mock.enqueueOnce('securetoken.googleapis.com/v1/token', 200, firebaseRefreshResponse());
    await provider.initialize();
    expect(provider.isAuthenticated()).toBe(true);

    // The initial refresh fires in the background; getAccessToken should
    // now return the minted token (which the refresh stored in memory).
    // Give the microtask a tick to settle.
    await new Promise((r) => setImmediate(r));
    const token = await provider.getAccessToken();
    expect(token).toBe('NEW_ACCESS');
  });

  it('clears the active pointer when decrypt fails (bad blob)', async () => {
    const { provider, globalDb, db, clock } = setup();
    // Write a bogus refresh-token row directly.
    globalDb.upsertUser({ id: 'u', email: 'u@x', signedInAt: clock.now() });
    db.prepare('UPDATE users SET refresh_token_enc = ? WHERE id = ?').run(
      Buffer.from('not-our-format').toString('base64'),
      'u',
    );
    globalDb.setActiveUserId('u');

    await provider.initialize();
    expect(provider.isAuthenticated()).toBe(false);
    expect(globalDb.getActiveUserId()).toBeNull();
  });
});

describe('TwinMindAuthProvider — access tokens', () => {
  async function signedInProvider() {
    const ctx = setup();
    await ctx.provider.initialize();
    ctx.mock.enqueueOnce('signInWithIdp', 200, firebaseSignInResponse());
    ctx.mock.enqueueOnce('/api/v2/google-oauth', 200, {});
    await ctx.provider.signIn();
    return ctx;
  }

  it('returns the cached access token when fresh', async () => {
    const { provider, mock } = await signedInProvider();
    // The access token was minted during signIn (it's the Firebase id_token).
    const t1 = await provider.getAccessToken();
    const t2 = await provider.getAccessToken();
    expect(t1).toBe(t2);
    // No additional fetch call beyond the two signIn calls.
    expect(mock.calls.filter((c) => c.url.includes('securetoken'))).toHaveLength(0);
  });

  it('refreshes when the token is past the expiry threshold', async () => {
    const { provider, clock, mock } = await signedInProvider();
    // Advance past the safety threshold (token TTL was 3600s; safety is 60s).
    clock.advance(3600 * 1000);
    mock.enqueueOnce('securetoken.googleapis.com/v1/token', 200, firebaseRefreshResponse());
    const tok = await provider.getAccessToken();
    expect(tok).toBe('NEW_ACCESS');
  });

  it('promise-locks concurrent refreshes', async () => {
    const { provider, clock, mock } = await signedInProvider();
    clock.advance(3600 * 1000);
    // Only one refresh response enqueued — two concurrent callers must share it.
    mock.enqueueOnce('securetoken.googleapis.com/v1/token', 200, firebaseRefreshResponse());
    const [a, b] = await Promise.all([provider.getAccessToken(), provider.getAccessToken()]);
    expect(a).toBe(b);
    expect(mock.calls.filter((c) => c.url.includes('securetoken'))).toHaveLength(1);
  });

  it('persists a rotated refresh token', async () => {
    const { provider, clock, mock, globalDb, secure } = await signedInProvider();
    clock.advance(3600 * 1000);
    mock.enqueueOnce(
      'securetoken.googleapis.com/v1/token',
      200,
      firebaseRefreshResponse('NEW_ACCESS', 'REFRESH_ROTATED'),
    );
    await provider.getAccessToken();
    const enc = globalDb.getRefreshTokenEnc('firebase-uid-1');
    expect(secure.decrypt(enc!)).toBe('REFRESH_ROTATED');
  });
});

describe('TwinMindAuthProvider — error classification', () => {
  it('signs out on a permanent refresh error (no retries)', async () => {
    const ctx = setup();
    await ctx.provider.initialize();
    ctx.mock.enqueueOnce('signInWithIdp', 200, firebaseSignInResponse());
    ctx.mock.enqueueOnce('/api/v2/google-oauth', 200, {});
    await ctx.provider.signIn();

    ctx.clock.advance(3600 * 1000);
    ctx.mock.enqueueOnce('securetoken.googleapis.com/v1/token', 400, {
      error: { message: 'INVALID_REFRESH_TOKEN' },
    });
    await expect(ctx.provider.getAccessToken()).rejects.toThrow(/INVALID_REFRESH_TOKEN/);
    expect(ctx.provider.isAuthenticated()).toBe(false);
    expect(ctx.globalDb.getActiveUserId()).toBeNull();
    // Refresh row is cleared.
    expect(ctx.globalDb.getRefreshTokenEnc('firebase-uid-1')).toBeNull();
  });
});

describe('TwinMindAuthProvider — signOut', () => {
  it('clears active, refresh token, and in-memory state; fires change', async () => {
    const ctx = setup();
    await ctx.provider.initialize();
    ctx.mock.enqueueOnce('signInWithIdp', 200, firebaseSignInResponse());
    ctx.mock.enqueueOnce('/api/v2/google-oauth', 200, {});
    await ctx.provider.signIn();

    const changes: Array<string | null> = [];
    ctx.provider.onAuthChange((s) => changes.push(s.userId));

    await ctx.provider.signOut();
    expect(ctx.provider.isAuthenticated()).toBe(false);
    expect(ctx.globalDb.getActiveUserId()).toBeNull();
    expect(ctx.globalDb.getRefreshTokenEnc('firebase-uid-1')).toBeNull();
    // User row is preserved so "Continue as <email>" works later.
    expect(ctx.globalDb.getUser('firebase-uid-1')).not.toBeNull();
    expect(changes.at(-1)).toBeNull();
  });
});
