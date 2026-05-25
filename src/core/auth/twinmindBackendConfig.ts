/**
 * twinmindBackendConfig — public configuration for the TwinMind auth + ASR
 * backend.
 *
 * Source of truth: environment variables, baked in at BUILD time via
 * esbuild's `define`. `scripts/build.cjs` reads `.env` and replaces every
 * `process.env.FIREBASE_WEB_API_KEY` (and the rest below) with a literal
 * string in the bundled `main.js`. The packaged app therefore needs no
 * `.env` file at runtime.
 *
 * Why these can be baked in: every value below is a PUBLIC identifier —
 * Firebase project ID + Web API key (both safe-to-expose per Firebase docs),
 * backend URLs, the web-login URL the system browser opens, and the Vercel
 * deployment-protection bypass token (not a user credential). The actual
 * per-user credential — the Firebase refresh token — is encrypted in macOS
 * Keychain and never bundled.
 *
 * Sign-in flow: the system browser opens `webLoginUrl`; the TwinMind webapp
 * runs the Google OAuth dance and redirects back via `twinmind://auth/callback`.
 * We never call Google directly, so there is no client ID / secret here.
 *
 * Why we don't crash on missing config: the build will succeed with
 * `undefined` values if `.env` is incomplete, but we'd rather show a clear
 * "missing FIREBASE_WEB_API_KEY" message in Settings than crash the whole
 * app at boot. Callers get a discriminated union: `{ ok: false, missing: [] }`.
 *
 * Tests bypass `process.env` entirely by passing a `env` argument.
 */

/** Snapshot of all env values needed by the TwinMind auth + ASR clients. */
export interface TwinMindBackendConfig {
  /** Firebase Web API key — used to call Firebase REST endpoints. */
  readonly firebaseWebApiKey: string;
  /** Firebase Auth tenant ID. Required by `signInWithCustomToken` and refresh calls. */
  readonly firebaseTenantId: string;
  /** Firebase project ID — only used for diagnostics / display. */
  readonly firebaseProjectId: string;
  /** Base URL for the TwinMind backend (no trailing slash). */
  readonly backendUrl: string;
  /** Vercel deployment-protection bypass header value. */
  readonly vercelProtectionBypass: string;
  /** Full URL of the chunk-transcription endpoint. */
  readonly transcribeUrl: string;
  /** Full URL of the per-meeting summary endpoint. */
  readonly summaryUrl: string;
  /**
   * Base URL of the TwinMind web app — used to construct the
   * `${appUrl}/m/${sessionId}` deep link that the "View Summary" button
   * opens externally. Defaults to `https://app.twinmind.com`.
   */
  readonly appUrl: string;
  /**
   * URL the system browser opens to begin sign-in. The TwinMind webapp
   * runs the Google OAuth dance there and redirects back to
   * `twinmind://auth/callback?token=<code>`. Defaults to the production
   * webapp; override via `TWINMIND_WEB_LOGIN_URL` to point at staging or a
   * local webapp during development.
   */
  readonly webLoginUrl: string;
  /**
   * Model identifier sent as the `model` form field for dictation chunks.
   * Defaults to `twinmind-fast-3`; override via `TWINMIND_DICTATION_MODEL`.
   */
  readonly dictationModel: string;
  /**
   * Model identifier sent as the `model` form field for meeting chunks.
   * Defaults to V1's value `twinmind-pro`; override via
   * `TWINMIND_MEETING_MODEL`.
   */
  readonly meetingModel: string;
}

/** V1's per-mode defaults. Override via env to A/B against other backend models. */
const DEFAULT_DICTATION_MODEL = 'twinmind-fast-3';
const DEFAULT_MEETING_MODEL = 'twinmind-pro';
const DEFAULT_APP_URL = 'https://app.twinmind.com';
const DEFAULT_WEB_LOGIN_URL = 'https://app.twinmind.com/login?via_desktop';

/**
 * Result of resolving the config from the environment. The discriminated
 * union forces every caller to handle the missing case explicitly.
 */
export type ConfigResolution =
  | { readonly ok: true; readonly config: TwinMindBackendConfig }
  | { readonly ok: false; readonly missing: readonly string[] };

/** Names of the env vars we look at, in the order they appear in error messages. */
export const REQUIRED_ENV_VARS = [
  'FIREBASE_WEB_API_KEY',
  'FIREBASE_TENANT_ID',
  'FIREBASE_PROJECT_ID',
  'TWINMIND_BACKEND_URL',
  'VERCEL_PROTECTION_BYPASS',
  'TWINMIND_TRANSCRIBE_URL',
  'TWINMIND_SUMMARY_URL',
] as const;

/**
 * Build-time-baked snapshot of every required env var.
 *
 * Each property reads `process.env.X` as a STATIC reference — esbuild's
 * `define` rewrites the right-hand side at build time to a literal string
 * (or `undefined` if `.env` was incomplete). A dynamic `process.env[name]`
 * lookup would NOT be replaced; the explicit list is what makes this work.
 *
 * Tests never observe these literals — they call `resolveTwinMindBackendConfig`
 * with an explicit `env` argument and ignore this object.
 */
const BUILT_IN_ENV: Record<(typeof REQUIRED_ENV_VARS)[number], string | undefined> & {
  TWINMIND_DICTATION_MODEL?: string;
  TWINMIND_MEETING_MODEL?: string;
  TWINMIND_APP_URL?: string;
  TWINMIND_WEB_LOGIN_URL?: string;
} = {
  FIREBASE_WEB_API_KEY: process.env.FIREBASE_WEB_API_KEY,
  FIREBASE_TENANT_ID: process.env.FIREBASE_TENANT_ID,
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
  TWINMIND_BACKEND_URL: process.env.TWINMIND_BACKEND_URL,
  VERCEL_PROTECTION_BYPASS: process.env.VERCEL_PROTECTION_BYPASS,
  TWINMIND_TRANSCRIBE_URL: process.env.TWINMIND_TRANSCRIBE_URL,
  TWINMIND_SUMMARY_URL: process.env.TWINMIND_SUMMARY_URL,
  // Optional — fall back to V1's defaults when absent.
  TWINMIND_DICTATION_MODEL: process.env.TWINMIND_DICTATION_MODEL,
  TWINMIND_MEETING_MODEL: process.env.TWINMIND_MEETING_MODEL,
  TWINMIND_APP_URL: process.env.TWINMIND_APP_URL,
  TWINMIND_WEB_LOGIN_URL: process.env.TWINMIND_WEB_LOGIN_URL,
};

/**
 * Read + validate the env. Production callers omit the arg and get the
 * build-time-baked values. Tests pass `env` explicitly so they can simulate
 * missing / present permutations without touching the real environment.
 *
 * Validation is intentionally loose — non-empty strings only. We don't try
 * to parse the URL or check the key format; the backend is the source of
 * truth for "is this key actually valid?".
 */
export function resolveTwinMindBackendConfig(
  env: NodeJS.ProcessEnv = BUILT_IN_ENV as unknown as NodeJS.ProcessEnv,
): ConfigResolution {
  const values: Partial<Record<(typeof REQUIRED_ENV_VARS)[number], string>> = {};
  const missing: string[] = [];

  for (const name of REQUIRED_ENV_VARS) {
    const raw = env[name];
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (trimmed.length === 0) {
      missing.push(name);
    } else {
      values[name] = trimmed;
    }
  }

  if (missing.length > 0) {
    return { ok: false, missing };
  }

  // Strip any trailing slash from the backend URL so callers can append
  // `/api/v2/...` without worrying about double slashes.
  const backendUrl = values.TWINMIND_BACKEND_URL!.replace(/\/+$/, '');

  // Optional overrides. Each falls back to a sane default when unset / empty.
  const optionalString = (raw: unknown, fallback: string): string => {
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : fallback;
  };
  const dictationModel = optionalString(env['TWINMIND_DICTATION_MODEL'], DEFAULT_DICTATION_MODEL);
  const meetingModel = optionalString(env['TWINMIND_MEETING_MODEL'], DEFAULT_MEETING_MODEL);
  const appUrl = optionalString(env['TWINMIND_APP_URL'], DEFAULT_APP_URL).replace(/\/+$/, '');
  const webLoginUrl = optionalString(env['TWINMIND_WEB_LOGIN_URL'], DEFAULT_WEB_LOGIN_URL);

  return {
    ok: true,
    config: {
      firebaseWebApiKey: values.FIREBASE_WEB_API_KEY!,
      firebaseTenantId: values.FIREBASE_TENANT_ID!,
      firebaseProjectId: values.FIREBASE_PROJECT_ID!,
      backendUrl,
      vercelProtectionBypass: values.VERCEL_PROTECTION_BYPASS!,
      transcribeUrl: values.TWINMIND_TRANSCRIBE_URL!,
      summaryUrl: values.TWINMIND_SUMMARY_URL!,
      appUrl,
      webLoginUrl,
      dictationModel,
      meetingModel,
    },
  };
}

/**
 * Thrown by auth/asr clients when they need the config but it isn't set.
 * Callers in main catch this and surface the `missing` list to Settings.
 */
export class TwinMindConfigMissingError extends Error {
  constructor(public readonly missing: readonly string[]) {
    super(
      `TwinMind backend not configured. Missing env vars: ${missing.join(', ')}`,
    );
    this.name = 'TwinMindConfigMissingError';
  }
}
