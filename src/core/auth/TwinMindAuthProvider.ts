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
 * Sign-in flow (post web-handoff): the renderer's "Sign In" button hits
 * `signIn()`, which opens the TwinMind webapp in the system browser. The
 * webapp completes Google OAuth and redirects to `twinmind://auth/callback?
 * token=<code>` — macOS LaunchServices routes that to our `open-url` handler
 * in main, which calls `deliverAuthCallback(url)` here. We then exchange the
 * code for a Firebase customToken via `/api/auth/exchange-web-handoff`, then
 * exchange that customToken for ID + refresh tokens via Firebase's
 * `signInWithCustomToken` REST endpoint.
 *
 * Security:
 *   - Refresh token: encrypted at rest via safeStorage; only decrypted into
 *     in-memory `currentRefreshToken`. Never logged.
 *   - Access token: never persisted. In-memory only. Truncated when logged.
 *   - Permanent errors (invalid_refresh_token / revoked / disabled / not
 *     found) trigger forced sign-out — we don't sit on a dead credential.
 *   - The web-handoff code is one-shot — the backend invalidates it on
 *     first use, so a stolen log message can't be replayed. We still
 *     redact the `?token=` query value when logging callback URLs.
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

// ─── Constants ──────────────────────────────────────────────────────────────

const REFRESH_INTERVAL_MS = 60 * 1000; // re-check every minute
const REFRESH_THRESHOLD_MS = 10 * 60 * 1000; // refresh when <10 min remain
const REFRESH_MAX_ATTEMPTS = 5;
const EXPIRY_SAFETY_MS = 60 * 1000; // treat tokens as expired 1 min before exp
const BACKOFF_BASE_MS = 2_000; // 2s, 4s, 6s, 8s, 10s
/** Max wait for the twinmind:// callback URL after opening the browser. */
const SIGN_IN_TIMEOUT_MS = 120 * 1000;

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
   * Override the timer scheduler. Production uses setTimeout/clearTimeout
   * + setInterval/clearInterval. Tests can supply stubs to keep the test
   * loop deterministic — periodic refresh + the sign-in callback timeout
   * both go through this.
   */
  readonly timers?: {
    setInterval(handler: () => void, ms: number): NodeJS.Timeout;
    clearInterval(handle: NodeJS.Timeout): void;
    setTimeout(handler: () => void, ms: number): NodeJS.Timeout;
    clearTimeout(handle: NodeJS.Timeout): void;
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

/**
 * In-flight sign-in state: the dance is split across two events — the user
 * starting the flow (signIn() call) and the OS later delivering a
 * twinmind:// callback URL via main's open-url handler. We hold the deferred
 * resolver here so deliverAuthCallback() can complete the promise from the
 * outside.
 */
interface PendingSignIn {
  resolveUrl: (url: string) => void;
  rejectUrl: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class TwinMindAuthProvider implements IAuthProvider {
  private readonly globalDb: GlobalDb;
  private readonly secureStorage: ISecureStorage;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly openBrowser: (url: string) => Promise<void> | void;
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
   * Active sign-in awaiting the twinmind:// callback URL from main's
   * open-url handler. Set when signIn() opens the browser; cleared when the
   * callback arrives, the timeout fires, or cancelSignIn() is called.
   */
  private pendingSignIn: PendingSignIn | null = null;

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
    this.timers = deps.timers ?? {
      setInterval: (h, ms) => setInterval(h, ms),
      clearInterval: (handle) => clearInterval(handle),
      setTimeout: (h, ms) => setTimeout(h, ms),
      clearTimeout: (handle) => clearTimeout(handle),
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
   * Run the full web-handoff dance:
   *   1. Open the TwinMind webapp in the system browser.
   *   2. Wait for the webapp to redirect to `twinmind://auth/callback?token=…`
   *      (delivered via `deliverAuthCallback()` from main's open-url handler).
   *   3. POST the code to `/api/auth/exchange-web-handoff` → Firebase custom
   *      token.
   *   4. POST the custom token to Firebase's `signInWithCustomToken` REST
   *      endpoint → Firebase ID + refresh tokens.
   *   5. Persist + flip state.
   *
   * Returns a structured result rather than throwing so the IPC layer can
   * map it cleanly to the renderer's `cancelled` / `network` / `unknown`
   * variants.
   */
  async signIn(): Promise<SignInResult> {
    if (!this.config) {
      return {
        ok: false,
        error: 'config_missing',
        message: `Missing env vars: ${(this.configMissing ?? []).join(', ')}`,
      };
    }

    // If a previous signIn() is still waiting for a callback (renderer
    // double-click, race), cancel it so we don't end up with two listeners
    // claiming the same delivery.
    this.cancelSignIn();

    let callbackUrl: string;
    try {
      callbackUrl = await this.openBrowserAndAwaitCallback(this.config.webLoginUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isCancel = /cancelled|timed out/i.test(msg);
      return {
        ok: false,
        error: isCancel ? 'cancelled' : 'unknown',
        message: msg,
      };
    }

    // Extract `?token=…` (URL param is `token`; the backend body field is `code`).
    let code: string;
    try {
      const parsed = new URL(callbackUrl);
      const t = parsed.searchParams.get('token');
      if (!t || t.length === 0) {
        throw new Error('callback missing token query parameter');
      }
      code = t;
    } catch (err) {
      return {
        ok: false,
        error: 'unknown',
        message: `Invalid sign-in callback: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Step 1: backend exchanges code → Firebase customToken.
    let customToken: string;
    try {
      customToken = await this.exchangeWebHandoff(code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: classifyNetworkError(msg), message: msg };
    }

    // Step 2: Firebase exchanges customToken → idToken + refreshToken.
    let firebase: FirebaseSignInResult;
    try {
      firebase = await this.exchangeFirebaseCustomToken(customToken);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: classifyNetworkError(msg), message: msg };
    }

    const user: InMemoryUser = {
      id: firebase.userId,
      email: firebase.email,
      name: firebase.displayName,
      photoUrl: firebase.photoUrl,
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

    return { ok: true };
  }

  /**
   * Called by main's `open-url` / `second-instance` handlers when the
   * twinmind:// callback URL is delivered. If a `signIn()` is waiting, it
   * picks the URL up and finishes the exchange. If no sign-in is in flight
   * (stale link clicked later, race), the URL is silently dropped.
   *
   * Never logs the token query value — only the URL's scheme + path, so a
   * shoulder-surfer reading the log can't replay the credential.
   */
  deliverAuthCallback(url: string): void {
    if (!this.pendingSignIn) {
      const safe = url.split('?')[0] ?? url;
      this.logger.warn('auth_provider: callback received with no in-flight signIn', {
        url: safe,
      });
      return;
    }
    this.pendingSignIn.resolveUrl(url);
    this.pendingSignIn = null;
  }

  /**
   * Reject the pending sign-in (if any) with a cancelled error. Called by
   * the AUTH_CANCEL_SIGN_IN IPC handler when the user clicks Cancel on
   * SignInScreen. Idempotent — no-op when nothing is pending.
   */
  cancelSignIn(): void {
    if (!this.pendingSignIn) return;
    this.pendingSignIn.rejectUrl(new Error('Sign-in cancelled'));
    this.pendingSignIn = null;
  }

  /**
   * Open the system browser to `webLoginUrl` and wait — up to
   * SIGN_IN_TIMEOUT_MS — for `deliverAuthCallback` to be called by main's
   * URL handler. Browser-open failures are non-fatal: even if openExternal
   * rejects, the user may have already navigated there in another tab.
   */
  private openBrowserAndAwaitCallback(webLoginUrl: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        this.pendingSignIn = null;
        reject(new Error('Sign-in timed out'));
      }, SIGN_IN_TIMEOUT_MS);

      this.pendingSignIn = {
        resolveUrl: (url) => {
          this.timers.clearTimeout(timer);
          resolve(url);
        },
        rejectUrl: (err) => {
          this.timers.clearTimeout(timer);
          reject(err);
        },
        timer,
      };

      Promise.resolve(this.openBrowser(webLoginUrl)).catch((err) => {
        // Logged but not fatal — the user can still complete the flow if
        // the browser was already open at the right URL.
        this.logger.warn('auth_provider: openBrowser failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      });
    });
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

  // ─── Internals: TwinMind exchange + Firebase REST ────────────────────────

  /**
   * Exchange the web-handoff code for a Firebase customToken. The code is
   * one-shot and the backend invalidates it on first use. No auth header —
   * the code itself is the credential. We still send the Vercel deployment-
   * protection-bypass header so staging URLs work (no-op on production).
   */
  private async exchangeWebHandoff(code: string): Promise<string> {
    if (!this.config) throw new TwinMindConfigMissingError(this.configMissing ?? []);
    const url = `${this.config.backendUrl}/api/auth/exchange-web-handoff`;
    const resp = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-vercel-protection-bypass': this.config.vercelProtectionBypass,
      },
      body: JSON.stringify({ code }),
    });
    const dataRaw = (await resp.json().catch(() => ({}))) as unknown;
    if (!resp.ok) {
      const msg = readErrorMessage(dataRaw);
      throw new Error(`exchange-web-handoff failed: ${msg}`);
    }
    // Response shape: { data: { customToken: "<firebase-custom-token-jwt>" } }
    const data = dataRaw as { data?: { customToken?: unknown } };
    const ct = data?.data?.customToken;
    if (typeof ct !== 'string' || ct.length === 0) {
      throw new Error('exchange-web-handoff: malformed response (missing data.customToken)');
    }
    return ct;
  }

  /**
   * Exchange the backend-minted Firebase custom token for Firebase ID +
   * refresh tokens. Identity claims (email / name / picture / transformed_sub)
   * ride inside the custom token and propagate into the resulting ID token's
   * payload — we decode the JWT to recover them since
   * `signInWithCustomToken` returns only tokens.
   */
  private async exchangeFirebaseCustomToken(customToken: string): Promise<FirebaseSignInResult> {
    if (!this.config) throw new TwinMindConfigMissingError(this.configMissing ?? []);
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(
      this.config.firebaseWebApiKey,
    )}`;
    const resp = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: customToken,
        returnSecureToken: true,
        tenantId: this.config.firebaseTenantId,
      }),
    });
    const dataRaw = (await resp.json().catch(() => ({}))) as unknown;
    if (!resp.ok) {
      const msg = readErrorMessage(dataRaw);
      throw new Error(`firebase signInWithCustomToken failed: ${msg}`);
    }
    const data = dataRaw as {
      idToken?: string;
      refreshToken?: string;
      expiresIn?: string | number;
    };
    if (!data.idToken || !data.refreshToken) {
      throw new Error('firebase signInWithCustomToken: malformed response');
    }
    const expiresInSec =
      typeof data.expiresIn === 'string'
        ? parseInt(data.expiresIn, 10)
        : data.expiresIn ?? 3600;

    const claims = decodeJwtPayload(data.idToken);
    const userId = pickStringClaim(claims, [
      'transformed_sub',
      'transfromed_sub', // tolerated backend typo, kept for backwards compat
      'user_id',
      'sub',
    ]);
    if (!userId) {
      throw new Error('firebase signInWithCustomToken: ID token has no usable subject claim');
    }
    const email = pickStringClaim(claims, ['email']) ?? '';
    const displayName = pickStringClaim(claims, ['name']);
    const pictureRaw = pickStringClaim(claims, ['picture']);

    return {
      idToken: data.idToken,
      refreshToken: data.refreshToken,
      expiresInSec,
      userId,
      email,
      displayName,
      photoUrl: pictureRaw ? toHighResPhoto(pictureRaw) : null,
    };
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
  readonly photoUrl: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decode the middle (payload) segment of a JWT. Returns an empty record on
 * any parse failure — callers degrade gracefully via `pickStringClaim` rather
 * than throwing. We do NOT verify the signature here; Firebase already did
 * that when minting the token, and we only consume it to read its claims.
 */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  try {
    const segments = jwt.split('.');
    if (segments.length < 2) return {};
    const payloadStr = Buffer.from(segments[1]!, 'base64url').toString('utf8');
    const parsed = JSON.parse(payloadStr) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** First non-empty string value in `claims` matching one of the keys, or null. */
function pickStringClaim(
  claims: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const k of keys) {
    const v = claims[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
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

