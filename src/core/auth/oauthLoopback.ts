/**
 * oauthLoopback — Google OAuth hybrid flow via the system browser and a
 * 127.0.0.1 loopback HTTP server.
 *
 * Architecture: matches V1's `authManager._openGoogleOAuth`, ported to TS.
 * Google blocks OAuth from embedded webviews (Electron `BrowserWindow`), so
 * we open the consent screen in the user's real browser and capture the
 * redirect via a temporary local server. Per Google's "OAuth 2.0 for native
 * desktop apps" recommendation.
 *
 * Why a fixed port (3000) and not :0: Google validates that the `redirect_uri`
 * used to exchange the auth code matches the one used during the consent
 * flow. The URI must be pre-registered in Google Cloud Console — so we pin
 * the port and document the requirement. Tests can override.
 *
 * Why `response_type=code id_token`: we need both — `code` for the backend
 * to exchange server-side (calendar tokens etc.), `id_token` for the
 * Firebase REST exchange that gives us the refresh token. We deliberately
 * do NOT request `token` (access_token); V1 dropped it and we never use it.
 *
 * Security:
 *   - `state` nonce: defends against CSRF on the callback. Generated here,
 *     verified on the POST-back.
 *   - `nonce`: defends against ID-token replay attacks; passed through to
 *     Google, present in the returned JWT.
 *   - Server binds to `127.0.0.1` only — never `0.0.0.0`.
 *   - Single-shot: server closes after the first valid callback.
 *   - 120 s hard timeout if the user never returns.
 */

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { TwinMindBackendConfig } from './twinmindBackendConfig';

/** Tokens returned by a successful loopback flow. */
export interface GoogleOAuthTokens {
  /** Single-use authorization code to exchange with the backend. */
  readonly code: string;
  /** Google ID token (JWT) — exchanged with Firebase REST next. */
  readonly idToken: string;
  /** The redirect URI used (echoed for `redirect_uri` matching at exchange time). */
  readonly redirectUri: string;
}

/** Standard scopes for the hybrid flow — identity + calendar.readonly. */
export const GOOGLE_OAUTH_SCOPES: readonly string[] = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/calendar.readonly',
];

const DEFAULT_PORT = 3000;
const DEFAULT_PATH = '/auth/callback';
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Build the Google consent URL for the hybrid flow. Pure function; safe to
 * call without side-effects. The `nonce` + `state` are passed in so the
 * caller can store them for verification on the callback.
 */
export function buildGoogleAuthUrl(args: {
  clientId: string;
  redirectUri: string;
  nonce: string;
  state: string;
  scopes?: readonly string[];
}): string {
  const params = new URLSearchParams({
    client_id: args.clientId,
    response_type: 'code id_token',
    redirect_uri: args.redirectUri,
    scope: (args.scopes ?? GOOGLE_OAUTH_SCOPES).join(' '),
    access_type: 'offline',
    prompt: 'consent',
    nonce: args.nonce,
    state: args.state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Parse the URL-encoded body our served HTML POSTs back. Extracts `code` /
 * `id_token` / `state` from the OAuth fragment.
 *
 * Pure function for ease of testing. Throws if any required field is missing
 * or if `state` doesn't match the expected nonce.
 */
export function extractTokensFromFragmentBody(
  body: string,
  expectedState: string,
): { code: string; idToken: string } {
  const params = new URLSearchParams(body);
  const error = params.get('error');
  if (error) {
    throw new Error(`OAuth provider returned error: ${error}`);
  }
  const code = params.get('code');
  const idToken = params.get('id_token');
  const state = params.get('state');
  if (!code || !idToken) {
    throw new Error('OAuth callback missing required tokens (code or id_token)');
  }
  if (!state || state !== expectedState) {
    // Don't echo the state in the error — it's a secret-ish value.
    throw new Error('OAuth callback state mismatch (possible CSRF)');
  }
  return { code, idToken };
}

/** Inputs to the loopback flow. */
export interface RunOAuthLoopbackInput {
  readonly config: Pick<TwinMindBackendConfig, 'googleOAuthClientId'>;
  /** Override for tests; production should leave at default (matches Google Cloud Console registration). */
  readonly port?: number;
  /** Override for tests. */
  readonly redirectPath?: string;
  /** Hard timeout (ms). Default 120 000. */
  readonly timeoutMs?: number;
  /** Injectable for tests; production passes Electron's `shell.openExternal`. */
  readonly openBrowser: (url: string) => Promise<void> | void;
  /**
   * Aborting this signal closes the loopback server and rejects the
   * returned promise with a "cancelled" message. Used by the renderer's
   * Cancel button so the user can bail out of a hung sign-in without
   * waiting for the 120 s timeout.
   */
  readonly abortSignal?: AbortSignal;
}

/**
 * Run a single OAuth loopback dance. Returns when the user grants consent
 * and the served HTML POSTs the fragment back to us. Closes the server
 * regardless of outcome.
 *
 * Throws on: missing tokens, state mismatch, timeout, port in use, server
 * error. Callers map these to UX-level outcomes (cancelled vs unknown).
 */
/**
 * EXPERIMENT FLAG — flip back to `false` to restore the original loopback flow.
 *
 * When `true`:
 *   - Redirect URI is `https://app.twinmind.com/auth/callback` (already
 *     registered in Google Cloud Console).
 *   - We do NOT start the localhost HTTP server (frees port 3000).
 *   - The function then has no way to RECEIVE the callback — the browser
 *     lands on the web page and the desktop just waits. Expected outcome
 *     until the web page is updated to forward to `twinmind://`:
 *       • Web page shows "Invalid state parameter" (validates against its
 *         own sessionStorage which doesn't have our state).
 *       • The desktop's 120 s timeout fires (or the user clicks Cancel).
 *       • signIn() returns { ok: false, error: 'cancelled' }.
 *   - This is intentional — we're confirming the failure mode before
 *     spending time on the protocol-handler implementation.
 *
 * When `false`: original loopback behavior (localhost:3000 HTTP server).
 */
const USE_WEB_REDIRECT = false;
const WEB_REDIRECT_URI = 'https://app.twinmind.com/auth/callback';

export async function runOAuthLoopback(
  input: RunOAuthLoopbackInput,
): Promise<GoogleOAuthTokens> {
  const port = input.port ?? DEFAULT_PORT;
  const path = input.redirectPath ?? DEFAULT_PATH;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // `localhost` in the URL (not `127.0.0.1`) to match what V1 registered
  // in Google Cloud Console — Google treats the two as DIFFERENT redirect
  // URIs and only accepts pre-registered ones. The server still binds to
  // 127.0.0.1 below (loopback only, never 0.0.0.0); the browser resolves
  // `localhost` to the same address.
  const redirectUri = USE_WEB_REDIRECT
    ? WEB_REDIRECT_URI
    : `http://localhost:${port}${path}`;

  const nonce = randomNonce();
  const state = randomNonce();
  const authUrl = buildGoogleAuthUrl({
    clientId: input.config.googleOAuthClientId,
    redirectUri,
    nonce,
    state,
  });

  return new Promise<GoogleOAuthTokens>((resolve, reject) => {
    let settled = false;
    let server: http.Server | null = null;
    let onAbort: (() => void) | null = null;

    const cleanup = (): void => {
      if (server) {
        const s = server;
        server = null;
        s.close();
      }
      if (onAbort && input.abortSignal) {
        input.abortSignal.removeEventListener('abort', onAbort);
        onAbort = null;
      }
    };

    // Fast-path: if the caller's signal is already aborted, bail before we
    // even open a socket. Otherwise wire a listener that closes the server
    // and rejects with a cancelled-specific message.
    if (input.abortSignal?.aborted) {
      reject(new Error('OAuth flow cancelled'));
      return;
    }
    if (input.abortSignal) {
      onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        cleanup();
        reject(new Error('OAuth flow cancelled'));
      };
      input.abortSignal.addEventListener('abort', onAbort);
    }

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('OAuth flow timed out'));
    }, timeoutMs);

    // EXPERIMENT mode: redirect goes to app.twinmind.com — we have no way
    // to RECEIVE the callback locally. Just open the browser and wait for
    // the timeout or a Cancel. The web page's behavior is what we're
    // observing; the desktop is intentionally a passive participant here.
    if (USE_WEB_REDIRECT) {
      Promise.resolve(input.openBrowser(authUrl)).catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        cleanup();
        reject(
          new Error(
            `Failed to open browser for OAuth: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      });
      return;
    }

    server = http.createServer((req, res) => {
      try {
        if (req.method === 'GET' && (req.url ?? '').startsWith(path)) {
          // Serve a tiny HTML page that reads the URL fragment client-side
          // and POSTs it back — browsers never send fragments to the server.
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(LOOPBACK_HTML);
          return;
        }
        if (req.method === 'POST' && req.url === '/auth/token') {
          let body = '';
          // Cap the body so a malicious local process can't OOM us. 8 KB
          // is well above what Google will ever send back.
          let oversize = false;
          req.on('data', (chunk: Buffer) => {
            body += chunk.toString('utf8');
            if (body.length > 8 * 1024) {
              oversize = true;
              req.destroy();
            }
          });
          req.on('end', () => {
            if (settled) return;
            if (oversize) {
              settled = true;
              clearTimeout(timeout);
              cleanup();
              reject(new Error('OAuth callback body too large'));
              return;
            }
            try {
              const { code, idToken } = extractTokensFromFragmentBody(body, state);
              settled = true;
              clearTimeout(timeout);
              res.writeHead(204);
              res.end();
              cleanup();
              resolve({ code, idToken, redirectUri });
            } catch (err) {
              settled = true;
              clearTimeout(timeout);
              res.writeHead(400);
              res.end();
              cleanup();
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          });
          return;
        }
        res.writeHead(404);
        res.end();
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    server.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cleanup();
      // EADDRINUSE = something is already on port 3000. Mention it explicitly
      // because it's the only common failure mode for this server.
      const msg =
        (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
          ? `OAuth loopback port ${port} in use; quit the other app and retry`
          : `OAuth loopback server failed: ${err.message}`;
      reject(new Error(msg));
    });

    server.listen(port, '127.0.0.1', () => {
      // Open the browser AFTER the server is listening so the callback can't
      // race ahead of us. Best-effort: if openBrowser throws, the user can
      // copy the URL from the surfaced error.
      Promise.resolve(input.openBrowser(authUrl)).catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        cleanup();
        reject(
          new Error(
            `Failed to open browser for OAuth: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      });
    });
  });
}

/**
 * The HTML served at the redirect URI. Reads the fragment client-side and
 * POSTs it back so the main-process Node server can see it. We strip the
 * `referrer-policy` to avoid leaking the fragment off-domain (defense in
 * depth — same-origin POST already keeps it local).
 */
const LOOPBACK_HTML = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<title>TwinMind sign-in</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; padding: 2rem; color: #1a1a1a; }
  h2 { margin-top: 1rem; font-weight: 500; }
</style>
</head><body>
<h2>Signing you in…</h2>
<script>
(function(){
  var fragment = window.location.hash.substring(1);
  if (!fragment) {
    document.body.innerHTML = '<h2>Sign-in failed.</h2><p>Please close this tab and try again.</p>';
    return;
  }
  fetch('/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: fragment
  }).then(function(r){
    if (r.ok) {
      document.body.innerHTML = '<h2>Signed in.</h2><p>You can close this tab.</p>';
    } else {
      document.body.innerHTML = '<h2>Sign-in failed.</h2><p>Please close this tab and try again.</p>';
    }
  }).catch(function(){
    document.body.innerHTML = '<h2>Sign-in failed.</h2><p>Please close this tab and try again.</p>';
  });
})();
</script>
</body></html>`;

/** 16-byte cryptographically random nonce, base64url-encoded — URL-safe. */
function randomNonce(): string {
  return randomBytes(16).toString('base64url');
}
