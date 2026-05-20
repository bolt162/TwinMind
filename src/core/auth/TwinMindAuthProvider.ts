/**
 * TwinMindAuthProvider — IAuthProvider over the TwinMind backend.
 *
 * Architecture: §9.6. Owns the OAuth + token-refresh lifecycle. Every
 * `IAsrClient` impl that talks to the TwinMind backend asks this provider
 * for an access token on every request — the provider hides refresh,
 * promise-locks concurrent attempts, and triggers sign-out on permanent
 * failure.
 *
 * State model (collapsed for external consumers):
 *   - unauthenticated: no `currentUser`. Tokens are absent.
 *   - authenticated:   `currentUser` is set. The refresh token is in memory
 *                      (decrypted at startup); the access token is minted
 *                      on demand. `isAuthenticated()` returns true the
 *                      moment we have a refresh token, even before the
 *                      first access-token mint.
 *
 * Persistence: every refresh-token rotation writes through to GlobalDb;
 * the row is encrypted via `ISecureStorage`. The access token is NEVER
 * persisted — it's a 1-hour JWT, cheaper to re-mint at startup than to
 * defend at rest.
 *
 * Per-user scope: this provider speaks to GlobalDb (machine-wide), not the
 * user-scoped JobStore. The lifecycle is:
 *   1. App starts → `initialize()` reads active_user_id from GlobalDb,
 *      decrypts the refresh token, schedules an immediate refresh.
 *   2. UI calls `signIn()` → OAuth dance → upsert into users → set active.
 *   3. UI calls `signOut()` → clear active + refresh_token_enc → state
 *      change fires → renderer re-routes to SignInScreen.
 *
 * Security:
 *   - Refresh token: encrypted at rest via safeStorage; only decrypted into
 *     in-memory `currentRefreshToken`. Never logged.
 *   - Access token: never persisted. In-memory only. Truncated when logged.
 *   - Permanent errors (invalid_refresh_token / revoked / disabled / not
 *     found) trigger forced sign-out — we don't sit on a dead credential.
 *   - Backend POST `/api/v2/google-oauth` is wrapped in try/catch; failure
 *     is non-fatal (V1 does the same — it only blocks calendar features,
 *     not auth itself).
 */

import type { Logger } from '@core/observability/Logger';
import { noopLogger } from '@core/observability/Logger';
import type { Clock } from '@core/util/Clock';
import type { ISecureStorage } from '@platform/ISecureStorage';
import { GlobalDb } from '@core/storage/GlobalDb';
import type { AuthStateChanged, AuthUserView } from '@ipc/channels';
import type { AuthState, AuthUnsubscribe, IAuthProvider } from './IAuthProvider';
import {
  TwinMindConfigMissingError,
  type ConfigResolution,
  type TwinMindBackendConfig,
} from './twinmindBackendConfig';
import { runOAuthLoopback, type GoogleOAuthTokens } from './oauthLoopback';

// ─── Constants ──────────────────────────────────────────────────────────────

const REFRESH_INTERVAL_MS = 60 * 1000; // re-check every minute
const REFRESH_THRESHOLD_MS = 10 * 60 * 1000; // refresh when <10 min remain
const REFRESH_MAX_ATTEMPTS = 5;
const EXPIRY_SAFETY_MS = 60 * 1000; // treat tokens as expired 1 min before exp
const BACKOFF_BASE_MS = 2_000; // 2s, 4s, 6s, 8s, 10s

/**
 * Substrings (case-insensitive) in Firebase REST error messages that mean
 * "this refresh token will never work again — don't retry, sign the user
 * out." Matches V1's PERMANENT_ERRORS list.
 */
const PERMANENT_ERROR_SUBSTRINGS = [
  'invalid_refresh_token',
  'token_revoked',
  'user_disabled',
  'user_not_found',
  'invalid_grant',
];

// ─── Types ──────────────────────────────────────────────────────────────────

/** Result of TwinMindAuthProvider.signIn() — coarse-grained outcome label. */
export type SignInError = 'cancelled' | 'config_missing' | 'network' | 'unknown';

export interface SignInResult {
  readonly ok: boolean;
  readonly error?: SignInError;
  readonly message?: string;
}

export interface TwinMindAuthProviderDeps {
  /** Resolved env config (ok or missing). Auth provider degrades gracefully when missing. */
  readonly configResolution: ConfigResolution;
  readonly globalDb: GlobalDb;
  readonly secureStorage: ISecureStorage;
  readonly clock: Clock;
  readonly logger?: Logger;
  /** Inject in tests; production uses Electron's shell.openExternal. */
  readonly openBrowser: (url: string) => Promise<void> | void;
  /** Inject in tests; defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof globalThis.fetch;
  /**
   * Inject in tests to skip the loopback HTTP server. Returns Google tokens
   * directly. The optional `signal` is passed in by `signIn()` so tests can
   * verify cancellation behavior.
   */
  readonly runOAuthFlow?: (
    config: TwinMindBackendConfig,
    signal: AbortSignal,
  ) => Promise<GoogleOAuthTokens>;
  /**
   * Override the timer scheduler. Production uses setInterval/clearInterval.
   * Tests can pass `{ setInterval: () => 0 as any, clearInterval: () => {} }`
   * to avoid background ticks (then drive refresh via `refreshNow` directly).
   */
  readonly timers?: {
    setInterval(handler: () => void, ms: number): NodeJS.Timeout;
    clearInterval(handle: NodeJS.Timeout): void;
  };
}

interface InMemoryUser {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly photoUrl: string | null;
}

interface InMemoryTokens {
  refreshToken: string;
  accessToken: string | null;
  accessTokenExpiresAt: number; // 0 = never minted
}

// ─── Class ──────────────────────────────────────────────────────────────────

export class TwinMindAuthProvider implements IAuthProvider {
  private readonly globalDb: GlobalDb;
  private readonly secureStorage: ISecureStorage;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly openBrowser: (url: string) => Promise<void> | void;
  private readonly runOAuthFlow: (
    config: TwinMindBackendConfig,
    signal: AbortSignal,
  ) => Promise<GoogleOAuthTokens>;
  private readonly timers: NonNullable<TwinMindAuthProviderDeps['timers']>;

  /** Snapshot of the resolved config; `null` when env is missing. */
  private readonly config: TwinMindBackendConfig | null;
  private readonly configMissing: readonly string[] | null;

  /** Current user; null when signed out. */
  private currentUser: InMemoryUser | null = null;
  /** Current tokens; null when signed out. */
  private currentTokens: InMemoryTokens | null = null;

  private refreshTimer: NodeJS.Timeout | null = null;
  /** Promise-lock for concurrent refresh attempts. */
  private inflightRefresh: Promise<string> | null = null;
  /**
   * AbortController for the currently in-flight signIn(). Set when signIn
   * starts; cleared when it settles. cancelSignIn() aborts this to make the
   * loopback server close and the in-flight promise reject early.
   */
  private inflightSignInAbort: AbortController | null = null;

  private readonly listeners = new Set<(state: AuthState) => void>();
  private initialized = false;

  constructor(deps: TwinMindAuthProviderDeps) {
    this.globalDb = deps.globalDb;
    this.secureStorage = deps.secureStorage;
    this.clock = deps.clock;
    this.logger = deps.logger ?? noopLogger;
    const f = deps.fetchImpl ?? globalThis.fetch;
    if (typeof f !== 'function') {
      throw new Error('TwinMindAuthProvider: no fetch impl available (Node < 18?)');
    }
    this.fetchImpl = f.bind(globalThis);
    this.openBrowser = deps.openBrowser;
    this.runOAuthFlow =
      deps.runOAuthFlow ??
      ((cfg, signal) =>
        runOAuthLoopback({
          config: cfg,
          openBrowser: this.openBrowser,
          abortSignal: signal,
        }));
    this.timers = deps.timers ?? {
      setInterval: (h, ms) => setInterval(h, ms),
      clearInterval: (handle) => clearInterval(handle),
    };

    if (deps.configResolution.ok) {
      this.config = deps.configResolution.config;
      this.configMissing = null;
    } else {
      this.config = null;
      this.configMissing = deps.configResolution.missing;
      this.logger.warn('auth_provider: config missing', {
        missing: deps.configResolution.missing,
      });
    }
  }

  // ─── IAuthProvider ───────────────────────────────────────────────────────

  /** True iff a refresh token has been loaded into memory. */
  isAuthenticated(): boolean {
    return this.currentUser !== null && this.currentTokens !== null;
  }

  /** Snapshot of identity for telemetry / Settings UI. */
  getState(): AuthState {
    if (!this.currentUser) {
      return { userId: null, label: null };
    }
    return {
      userId: this.currentUser.id,
      label: this.currentUser.email,
    };
  }

  onAuthChange(cb: (state: AuthState) => void): AuthUnsubscribe {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  // ─── Richer view for IPC ─────────────────────────────────────────────────

  /** Renderer-facing view of auth state. Matches the AUTH_STATE_CHANGED payload. */
  getViewState(): AuthStateChanged {
    const user: AuthUserView | null = this.currentUser
      ? {
          id: this.currentUser.id,
          email: this.currentUser.email,
          name: this.currentUser.name,
          photoUrl: this.currentUser.photoUrl,
        }
      : null;
    return {
      isAuthenticated: user !== null,
      user,
      configMissing: this.configMissing,
    };
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Read persisted state from GlobalDb, decrypt the refresh token, schedule
   * the first refresh check. Call once at app start.
   *
   * Soft-fails on missing config — provider stays unauthenticated until the
   * user fixes their env and restarts. Soft-fails on decrypt failure — we
   * clear the bad row and force the user to sign in again. Never throws.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const activeUserId = this.globalDb.getActiveUserId();
    if (!activeUserId) {
      this.emitChange();
      return;
    }

    const userRow = this.globalDb.getUser(activeUserId);
    if (!userRow || !userRow.hasRefreshToken) {
      // Pointer dangles; clear it so future sign-ins go through the welcome.
      this.globalDb.setActiveUserId(null);
      this.emitChange();
      return;
    }

    let refreshToken: string;
    try {
      const enc = this.globalDb.getRefreshTokenEnc(activeUserId);
      if (!enc) {
        this.globalDb.setActiveUserId(null);
        this.emitChange();
        return;
      }
      refreshToken = this.secureStorage.decrypt(enc);
    } catch (err) {
      this.logger.warn('auth_provider: refresh token decrypt failed; clearing', {
        message: err instanceof Error ? err.message : String(err),
      });
      this.globalDb.clearRefreshTokenEnc(activeUserId);
      this.globalDb.setActiveUserId(null);
      this.emitChange();
      return;
    }

    this.currentUser = {
      id: userRow.id,
      email: userRow.email,
      name: userRow.name,
      photoUrl: userRow.photoUrl,
    };
    this.currentTokens = {
      refreshToken,
      accessToken: null,
      accessTokenExpiresAt: 0,
    };
    this.startRefreshTimer();
    this.emitChange();

    // Best-effort initial refresh — verifies the refresh token still works
    // and mints the first access token. Permanent errors flip us to signed-out.
    this.refreshNow().catch((err) => {
      this.logger.warn('auth_provider: initial refresh failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /** Stop the refresh timer; safe to call multiple times. App-shutdown only. */
  shutdown(): void {
    this.stopRefreshTimer();
  }

  // ─── Sign in / sign out ──────────────────────────────────────────────────

  /**
   * Run the full Google → Firebase → backend dance, persist tokens, fire
   * state change. Returns a structured result rather than throwing so the
   * IPC layer can return the error class to the renderer cleanly.
   */
  async signIn(): Promise<SignInResult> {
    if (!this.config) {
      return {
        ok: false,
        error: 'config_missing',
        message: `Missing env vars: ${(this.configMissing ?? []).join(', ')}`,
      };
    }

    // If a previous signIn() is somehow still in flight (renderer double-
    // click, race), abort it before starting a new one so the loopback
    // server doesn't EADDRINUSE on port 3000.
    this.inflightSignInAbort?.abort();
    const abort = new AbortController();
    this.inflightSignInAbort = abort;

    let googleTokens: GoogleOAuthTokens;
    try {
      googleTokens = await this.runOAuthFlow(this.config, abort.signal);
    } catch (err) {
      // The loopback module surfaces "timeout" → user closed the window /
      // never returned; "cancelled" → cancelSignIn() called. Both map to
      // `cancelled` so the UI shows a calm "try again" rather than a scary
      // error.
      const msg = err instanceof Error ? err.message : String(err);
      const isCancel = /cancelled|timed out|state mismatch|missing required tokens|EADDRINUSE/i.test(msg);
      // Only clear inflight if this is OUR abort — if a newer signIn already
      // replaced it, don't clobber that. Same-identity check via reference.
      if (this.inflightSignInAbort === abort) this.inflightSignInAbort = null;
      return {
        ok: false,
        error: isCancel ? 'cancelled' : 'unknown',
        message: msg,
      };
    }

    let firebase: FirebaseSignInResult;
    try {
      firebase = await this.exchangeWithFirebase(googleTokens.idToken);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: classifyNetworkError(msg), message: msg };
    }

    const userId = firebase.userId;
    const profile = parseRawUserInfo(firebase.rawUserInfo);
    const user: InMemoryUser = {
      id: userId,
      email: firebase.email,
      name: firebase.displayName ?? profile.name ?? null,
      photoUrl: profile.picture ? toHighResPhoto(profile.picture) : null,
    };

    const expiresAt = this.clock.now() + Math.max(0, firebase.expiresInSec * 1000);

    // Persist BEFORE flipping in-memory state — if encryption fails (keyring
    // unavailable) we'd rather not enter an authenticated state we can't
    // resume from on next launch.
    let enc: string;
    try {
      enc = this.secureStorage.encrypt(firebase.refreshToken);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error('auth_provider: refresh-token encrypt failed', { message: msg });
      return {
        ok: false,
        error: 'unknown',
        message: `Could not securely store credentials: ${msg}`,
      };
    }
    this.globalDb.upsertUser({
      id: user.id,
      email: user.email,
      name: user.name,
      photoUrl: user.photoUrl,
      signedInAt: this.clock.now(),
    });
    this.globalDb.setRefreshTokenEnc(user.id, enc);
    this.globalDb.setActiveUserId(user.id);

    this.currentUser = user;
    this.currentTokens = {
      refreshToken: firebase.refreshToken,
      accessToken: firebase.idToken,
      accessTokenExpiresAt: expiresAt,
    };
    this.startRefreshTimer();
    this.emitChange();

    // Backend sync — non-fatal. The user is signed in regardless.
    this.postAuthCodeToBackend(
      googleTokens.code,
      firebase.idToken,
      googleTokens.redirectUri,
    ).catch((err) => {
      this.logger.warn('auth_provider: backend sync failed (non-fatal)', {
        message: err instanceof Error ? err.message : String(err),
      });
    });

    // Sign-in succeeded — release the in-flight abort slot.
    if (this.inflightSignInAbort === abort) this.inflightSignInAbort = null;
    return { ok: true };
  }

  /**
   * Abort the currently in-flight signIn() — closes the loopback server
   * and causes the in-flight promise to resolve with `error: 'cancelled'`.
   * No-op when no sign-in is running. Called by the AUTH_CANCEL_SIGN_IN
   * IPC handler when the user clicks Cancel on SignInScreen.
   */
  cancelSignIn(): void {
    this.inflightSignInAbort?.abort();
  }

  /**
   * Clear in-memory + persisted credentials. Keeps the user row so the
   * welcome screen can offer "Continue as <email>" later — only the
   * refresh-token column is cleared.
   */
  async signOut(): Promise<void> {
    this.stopRefreshTimer();
    const userId = this.currentUser?.id ?? this.globalDb.getActiveUserId();
    if (userId) {
      this.globalDb.clearRefreshTokenEnc(userId);
    }
    this.globalDb.setActiveUserId(null);
    this.currentUser = null;
    this.currentTokens = null;
    this.inflightRefresh = null;
    this.emitChange();
  }

  // ─── Token access ────────────────────────────────────────────────────────

  /**
   * Return a valid access token, refreshing if needed. Throws if the user
   * isn't signed in or the refresh chain fails permanently. Promise-locked
   * so concurrent callers share one refresh.
   */
  async getAccessToken(): Promise<string> {
    if (!this.currentTokens) {
      throw new Error('TwinMindAuthProvider: not signed in');
    }
    const t = this.currentTokens;
    if (t.accessToken && this.clock.now() < t.accessTokenExpiresAt - EXPIRY_SAFETY_MS) {
      return t.accessToken;
    }
    return this.refreshNow();
  }

  /**
   * Force a token refresh now. Other callers piggyback on the same promise.
   * Wraps the actual refresh in retry logic; permanent failures trigger
   * sign-out before throwing.
   */
  async refreshNow(): Promise<string> {
    if (this.inflightRefresh) {
      return this.inflightRefresh;
    }
    this.inflightRefresh = this.doRefreshWithRetry().finally(() => {
      this.inflightRefresh = null;
    });
    return this.inflightRefresh;
  }

  // ─── Internals: refresh + retry ──────────────────────────────────────────

  private async doRefreshWithRetry(): Promise<string> {
    if (!this.config) {
      throw new TwinMindConfigMissingError(this.configMissing ?? []);
    }
    let lastErr: unknown = new Error('refresh failed (no attempts ran)');
    for (let attempt = 0; attempt < REFRESH_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.doRefresh();
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message.toLowerCase() : String(err);
        if (PERMANENT_ERROR_SUBSTRINGS.some((s) => msg.includes(s))) {
          this.logger.error('auth_provider: permanent refresh error; signing out', {
            attempt,
          });
          await this.signOut();
          throw err;
        }
        if (attempt < REFRESH_MAX_ATTEMPTS - 1) {
          const delay = BACKOFF_BASE_MS * (attempt + 1);
          await sleep(delay);
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async doRefresh(): Promise<string> {
    if (!this.config) {
      throw new TwinMindConfigMissingError(this.configMissing ?? []);
    }
    if (!this.currentTokens) {
      throw new Error('refresh: not signed in');
    }
    const refreshToken = this.currentTokens.refreshToken;
    const url = `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(
      this.config.firebaseWebApiKey,
    )}`;
    const resp = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    const dataRaw = (await resp.json().catch(() => ({}))) as unknown;
    if (!resp.ok) {
      const msg = readErrorMessage(dataRaw);
      throw new Error(`token refresh failed: ${msg}`);
    }
    const data = dataRaw as {
      id_token?: string;
      refresh_token?: string;
      expires_in?: string | number;
      user_id?: string;
    };
    if (!data.id_token || !data.expires_in) {
      throw new Error('token refresh: malformed response');
    }
    const expiresInSec =
      typeof data.expires_in === 'string'
        ? parseInt(data.expires_in, 10)
        : data.expires_in;
    const expiresAt = this.clock.now() + Math.max(0, expiresInSec) * 1000;

    // Apply state in memory first.
    this.currentTokens.accessToken = data.id_token;
    this.currentTokens.accessTokenExpiresAt = expiresAt;

    // Firebase MAY rotate the refresh token — always persist the latest.
    if (data.refresh_token && data.refresh_token !== refreshToken) {
      this.currentTokens.refreshToken = data.refresh_token;
      if (this.currentUser) {
        try {
          const enc = this.secureStorage.encrypt(data.refresh_token);
          this.globalDb.setRefreshTokenEnc(this.currentUser.id, enc);
        } catch (err) {
          this.logger.warn('auth_provider: refresh-token rotation persist failed', {
            message: err instanceof Error ? err.message : String(err),
          });
          // Continue — we have the new token in memory; we'll just re-rotate
          // on the next refresh.
        }
      }
    }

    return data.id_token;
  }

  private startRefreshTimer(): void {
    this.stopRefreshTimer();
    this.refreshTimer = this.timers.setInterval(() => {
      this.checkAndRefreshIfDue().catch((err) => {
        this.logger.warn('auth_provider: periodic refresh check failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      });
    }, REFRESH_INTERVAL_MS);
  }

  private stopRefreshTimer(): void {
    if (this.refreshTimer) {
      this.timers.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async checkAndRefreshIfDue(): Promise<void> {
    if (!this.currentTokens) return;
    const expiresAt = this.currentTokens.accessTokenExpiresAt;
    // 0 means "never minted yet" — initialize() already triggers the first
    // mint, so we only refresh here when the access token is real but stale.
    if (expiresAt === 0) return;
    if (expiresAt - this.clock.now() < REFRESH_THRESHOLD_MS) {
      await this.refreshNow();
    }
  }

  // ─── Internals: Firebase REST + backend POST + user-info parsing ─────────

  private async exchangeWithFirebase(googleIdToken: string): Promise<FirebaseSignInResult> {
    if (!this.config) throw new TwinMindConfigMissingError(this.configMissing ?? []);
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${encodeURIComponent(
      this.config.firebaseWebApiKey,
    )}`;
    const resp = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        postBody: `id_token=${encodeURIComponent(googleIdToken)}&providerId=google.com`,
        requestUri: 'http://127.0.0.1',
        returnIdpCredential: true,
        returnSecureToken: true,
        tenantId: this.config.firebaseTenantId,
      }),
    });
    const dataRaw = (await resp.json().catch(() => ({}))) as unknown;
    if (!resp.ok) {
      const msg = readErrorMessage(dataRaw);
      throw new Error(`firebase signInWithIdp failed: ${msg}`);
    }
    const data = dataRaw as {
      idToken?: string;
      refreshToken?: string;
      expiresIn?: string | number;
      localId?: string;
      email?: string;
      displayName?: string;
      rawUserInfo?: string;
    };
    if (!data.idToken || !data.refreshToken || !data.email || !data.localId) {
      throw new Error('firebase signInWithIdp: malformed response');
    }
    const expiresInSec =
      typeof data.expiresIn === 'string'
        ? parseInt(data.expiresIn, 10)
        : data.expiresIn ?? 3600;

    const userId = extractTransformedSub(data.idToken) ?? data.localId;

    return {
      idToken: data.idToken,
      refreshToken: data.refreshToken,
      expiresInSec,
      userId,
      email: data.email,
      displayName: data.displayName ?? null,
      rawUserInfo: data.rawUserInfo ?? null,
    };
  }

  private async postAuthCodeToBackend(
    authCode: string,
    firebaseIdToken: string,
    redirectUri: string,
  ): Promise<void> {
    if (!this.config) return;
    const resp = await this.fetchImpl(`${this.config.backendUrl}/api/v2/google-oauth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${firebaseIdToken}`,
        'x-vercel-protection-bypass': this.config.vercelProtectionBypass,
      },
      body: JSON.stringify({
        authCode,
        tenantId: this.config.firebaseTenantId,
        redirectUri,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`backend sync HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
  }

  // ─── Internals: listeners ────────────────────────────────────────────────

  private emitChange(): void {
    const state = this.getState();
    for (const cb of this.listeners) {
      try {
        cb(state);
      } catch (err) {
        this.logger.warn('auth_provider: listener threw', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

interface FirebaseSignInResult {
  readonly idToken: string;
  readonly refreshToken: string;
  readonly expiresInSec: number;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly rawUserInfo: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decode the middle segment of a JWT and read `transformed_sub` (with a
 * tolerant fallback for the backend's known typo). Returns null on any
 * parse failure — caller falls back to the Firebase uid.
 */
function extractTransformedSub(jwt: string): string | null {
  try {
    const segments = jwt.split('.');
    if (segments.length < 2) return null;
    const payloadStr = Buffer.from(segments[1]!, 'base64url').toString('utf8');
    const payload = JSON.parse(payloadStr) as Record<string, unknown>;
    const v = payload['transformed_sub'] ?? payload['transfromed_sub'];
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** Parse the rawUserInfo JSON-string field from signInWithIdp. */
function parseRawUserInfo(raw: string | null): { name?: string; picture?: string } {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const name = typeof obj['name'] === 'string' ? (obj['name'] as string) : undefined;
    const picture =
      typeof obj['picture'] === 'string' ? (obj['picture'] as string) : undefined;
    const result: { name?: string; picture?: string } = {};
    if (name !== undefined) result.name = name;
    if (picture !== undefined) result.picture = picture;
    return result;
  } catch {
    return {};
  }
}

/** Bump Google profile photos to the high-res variant we want for display. */
function toHighResPhoto(url: string, size = 400): string {
  if (!url.includes('googleusercontent.com')) return url;
  if (url.match(/=s\d+/)) {
    return url.replace(/=s\d+/, `=s${size}`);
  }
  return `${url}=s${size}`;
}

/** Pull a useful message out of an unknown JSON error body. */
function readErrorMessage(body: unknown): string {
  if (typeof body !== 'object' || body === null) return String(body ?? 'unknown');
  const obj = body as Record<string, unknown>;
  const err = obj['error'];
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null) {
    const m = (err as Record<string, unknown>)['message'];
    if (typeof m === 'string') return m;
  }
  return JSON.stringify(body).slice(0, 200);
}

/** Coarse classifier — "network-ish" vs "everything else." */
function classifyNetworkError(msg: string): SignInError {
  if (/fetch failed|ECONN|EAI_AGAIN|ENOTFOUND|network/i.test(msg)) return 'network';
  return 'unknown';
}

