/**
 * Playwright fixture that boots the packaged Electron app for a single spec.
 *
 * Wires every e2e knob:
 *   - tmp userData dir (DB / Keychain isolated per spec)
 *   - TWINMIND_E2E=1 (swaps DarwinPermissionService + DarwinPasteService for
 *     in-memory fakes; populates `globalThis.__e2e`)
 *   - TWINMIND_MIC_BACKEND=mock (audio-process emits silence frames; no native
 *     CoreAudio capture)
 *   - TWINMIND_ASR_PROVIDER=mock (no network calls; UploadQueue gets a fixed
 *     transcript per chunk)
 *
 * Helpers exposed on the returned `TestApp`:
 *   - `mainPage`: Playwright Page bound to the main BrowserWindow
 *   - `hudPage`: Playwright Page bound to the HUD window (when present)
 *   - `setPermission(kind, grant)`: mutate the fake permission service
 *   - `deliverAuthCallback(url)`: feed a `twinmind://…` URL back through
 *     `app.on('open-url')` as if macOS LaunchServices had delivered it
 *   - `waitForLastAuthBrowserUrl()`: poll for the URL the auth provider
 *     "opened in the browser" (intercepted in e2e mode)
 *   - `diagnostics()`: cheap state snapshot for assertions
 *   - `close()`: idempotent app teardown + tmp dir cleanup
 *
 * The fixture deliberately avoids new IPC channels. Test-side state changes
 * route through Playwright's `electronApp.evaluate(cb)` which runs `cb`
 * inside main — `globalThis.__e2e` is just a typed grab-bag of hooks.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import dotenv from 'dotenv';
import { captureDevSignInCallback } from './oauth';

/** Resolve repo root from this file's path (`tests/e2e/fixtures/app.ts`). */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'dist', 'main', 'main.js');

/**
 * Inspection knob: set TWINMIND_E2E_SLOWMO=3000 (ms) to insert a pause
 * after every Playwright action (Page.click, Page.fill, Locator.click,
 * Locator.fill, etc.). Unset / 0 = no slowdown. CI keeps it off; locals
 * use it to watch what specs are actually doing.
 *
 * Implementation: Playwright's _electron.launch() doesn't support slowMo
 * in its public API, so we monkey-patch Locator's prototype methods + the
 * direct Page action methods on first launch. The patch sticks for the
 * lifetime of the worker process — which is exactly the scope we want.
 */
const SLOWMO_MS = (() => {
  const v = parseInt(process.env.TWINMIND_E2E_SLOWMO ?? '0', 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
})();

let slowMoInstalled = false;

function installSlowMo(samplePage: Page): void {
  if (SLOWMO_MS <= 0 || slowMoInstalled) return;
  slowMoInstalled = true;

  const sleep = (): Promise<void> => new Promise((r) => setTimeout(r, SLOWMO_MS));

  // Wrap Locator.* (covers `page.getByTestId(...).click()` etc.). The
  // Locator class is shared across every locator built from any page in
  // this Node process, so patching the prototype once covers all callers.
  const sampleLocator = samplePage.locator('html');
  const LocatorProto = Object.getPrototypeOf(sampleLocator) as Record<string, unknown>;
  for (const method of [
    'click',
    'fill',
    'press',
    'check',
    'uncheck',
    'selectOption',
    'dblclick',
    'hover',
    'tap',
    'setChecked',
  ]) {
    const original = LocatorProto[method] as ((...args: unknown[]) => Promise<unknown>) | undefined;
    if (typeof original !== 'function') continue;
    LocatorProto[method] = async function (this: unknown, ...args: unknown[]) {
      const r = await original.apply(this, args);
      await sleep();
      return r;
    };
  }

  // Page-level action methods (`page.click(selector)` style). Most specs
  // use locator-style, but cover this path too for completeness.
  const PageProto = Object.getPrototypeOf(samplePage) as Record<string, unknown>;
  for (const method of ['click', 'fill', 'press', 'check', 'uncheck', 'selectOption', 'dblclick', 'hover', 'tap']) {
    const original = PageProto[method] as ((...args: unknown[]) => Promise<unknown>) | undefined;
    if (typeof original !== 'function') continue;
    PageProto[method] = async function (this: unknown, ...args: unknown[]) {
      const r = await original.apply(this, args);
      await sleep();
      return r;
    };
  }
}

/** Match the types declared in `src/platform/test/e2eHooks.ts`. */
export type PermissionKind = 'mic' | 'audioCapture' | 'accessibility' | 'notifications';
export type PermissionGrant = 'granted' | 'denied' | 'not_determined' | 'unavailable';

export interface E2EDiagnostics {
  auth: {
    isAuthenticated: boolean;
    userId: string | null;
    userEmail: string | null;
  };
  orchestrator: {
    state: string;
    mode: string;
    sessionId: string | null;
  };
  permissions: Record<string, string>;
  composedUserId: string | null;
}

/** Returned by `launchApp()`. Disposes via `close()`. */
export interface TestApp {
  readonly electronApp: ElectronApplication;
  readonly userDataDir: string;
  /** First BrowserWindow Electron creates after boot (the main window). */
  mainPage(): Promise<Page>;
  /** HUD window (may take a moment to appear post-sign-in / post-wizard). */
  hudPage(timeoutMs?: number): Promise<Page>;
  setPermission(kind: PermissionKind, grant: PermissionGrant): Promise<void>;
  deliverAuthCallback(url: string): Promise<void>;
  /** Poll until the auth provider has "opened" a sign-in URL, then return it. */
  waitForLastAuthBrowserUrl(timeoutMs?: number): Promise<string>;
  diagnostics(): Promise<E2EDiagnostics>;
  /**
   * Drive a full sign-in: click "Sign in" → drive the dev webapp's
   * test-secret field in a separate Chromium context → deliver the
   * `twinmind://` callback → wait for the auth provider to flip to
   * authenticated. Reads the secret from `TWINMIND_E2E_TEST_SECRET` by
   * default; override via `opts.secret` for negative tests.
   */
  signIn(opts?: SignInOptions): Promise<void>;
  /**
   * Mark onboarding as completed in GlobalDb without driving the wizard UI.
   *
   * IMPORTANT: call this BEFORE `signIn()`. App.tsx fetches wizard status
   * once per auth-state change, so the flag has to be written before the
   * post-sign-in fetch fires. Calling this AFTER sign-in writes the DB
   * flag but the renderer is already on OnboardingFlow with stale state —
   * use `walkOnboardingWizard()` for the post-sign-in path.
   */
  completeWizard(): Promise<void>;
  /**
   * Click through every Continue button of the onboarding wizard, then
   * Done. Used by specs that need the wizard dismissed after sign-in but
   * don't care about per-step assertions (B1 covers those).
   */
  walkOnboardingWizard(): Promise<void>;
  /**
   * Force the UpdateService into `ready` state so the home-page
   * UpdateBanner mounts. e2e launches are not packaged, so the real
   * electron-updater path is disabled and never fires update-downloaded —
   * this hook routes around that.
   */
  forceUpdateReady(version: string): Promise<void>;
  /**
   * Quit + relaunch against the same userData dir to assert persistence.
   * The returned TestApp owns its own teardown but shares the dir with the
   * caller — pass `keepUserDataDir: true` to the original launch so cleanup
   * happens once at the end.
   */
  relaunch(opts?: { env?: Record<string, string | undefined> }): Promise<TestApp>;
  close(): Promise<void>;
}

export interface SignInOptions {
  /** Override `process.env.TWINMIND_E2E_TEST_SECRET`. */
  readonly secret?: string;
  /** Override the auth provider's signInUrl (rarely needed). */
  readonly signInUrl?: string;
  /** Run the OAuth driver headed for visual debugging. */
  readonly headed?: boolean;
}

export interface LaunchAppOptions {
  /**
   * Override the userData dir (e.g. to reuse the previous spec's signed-in
   * state). When unset a fresh tmpdir is created and removed on close.
   */
  readonly userDataDir?: string;
  /**
   * When true the launcher will NOT delete `userDataDir` on close. Set this
   * on the first launch of a multi-launch test (A3: relaunch-persistence) so
   * the second launch can read the persisted DB / Keychain blob.
   */
  readonly keepUserDataDir?: boolean;
  /** Extra env vars to set on the Electron process. */
  readonly env?: Record<string, string | undefined>;
  /**
   * Override the dev/prod renderer flag. By default we force production mode
   * (loads `dist/renderer/index.html`) so tests run against the same code
   * path the DMG ships.
   */
  readonly dev?: boolean;
  /**
   * Mock mic backend to install in the audio-process:
   *  - 'mock' (default): silent PCM — VAD will skip every chunk.
   *  - 'mock_sine': 440 Hz sine wave — chunks have signal, transcripts land.
   *
   * Phase 6 recording specs need `mock_sine` so MockAsrClient actually
   * sees non-silent audio and writes a real transcript row.
   */
  readonly micBackend?: 'mock' | 'mock_sine';
}

/**
 * Boot Electron with the e2e env switches set. Caller MUST `await app.close()`
 * even on test failure — the registered `afterEach` does this automatically
 * if you wire it via Playwright fixtures.
 */
export async function launchApp(opts: LaunchAppOptions = {}): Promise<TestApp> {
  // `.env.test` is the canonical e2e env: `build:e2e` bakes its
  // backend/Firebase values into the bundle, and we read its runtime-only
  // vars (TWINMIND_E2E_TEST_SECRET, VERCEL_PROTECTION_BYPASS) here so the
  // OAuth helper can pick them up. The prod `.env` is never touched by the
  // e2e flow — that's the point of running with .env.test in the first
  // place. dotenv ignores already-set process.env values, so CI vars still
  // win over the file.
  dotenv.config({ path: path.join(REPO_ROOT, '.env.test') });

  if (!fs.existsSync(MAIN_ENTRY)) {
    throw new Error(
      `[e2e] missing build: ${MAIN_ENTRY} not found. Run \`npm run build:e2e\` first.`,
    );
  }

  const ownsUserDataDir = !opts.userDataDir && !opts.keepUserDataDir;
  const userDataDir =
    opts.userDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'twinmind-e2e-'));

  const env: Record<string, string> = {
    ...process.env,
    TWINMIND_E2E: '1',
    TWINMIND_MIC_BACKEND: opts.micBackend ?? 'mock',
    TWINMIND_ASR_PROVIDER: 'mock',
    TWINMIND_USER_DATA_DIR: userDataDir,
    NODE_ENV: opts.dev ? 'development' : 'production',
    ...stringifyEnv(opts.env ?? {}),
  };

  const electronApp = await electron.launch({
    args: [MAIN_ENTRY],
    env,
    // Hand the bundled Electron from devDependencies — never the user's
    // system electron. Playwright resolves this from PATH otherwise and
    // dev-tooling drift bites.
    executablePath: require('electron') as unknown as string,
  });

  // Forward Electron's stdout/stderr to the test runner's console so
  // pino-logged warnings (auth-provider errors, IPC validation, fetch
  // failures) are visible alongside the spec output. Without this they go
  // into the Electron process's stdio buffer and disappear on test exit.
  electronApp.process().stdout?.on('data', (chunk: Buffer | string) => {
    process.stdout.write(`[electron-stdout] ${chunk.toString()}`);
  });
  electronApp.process().stderr?.on('data', (chunk: Buffer | string) => {
    process.stderr.write(`[electron-stderr] ${chunk.toString()}`);
  });

  return makeTestApp(electronApp, userDataDir, ownsUserDataDir);
}

/** Convert a partial-string-env to a strict string-only record. */
function stringifyEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') out[k] = v;
  return out;
}

function makeTestApp(
  electronApp: ElectronApplication,
  userDataDir: string,
  ownsUserDataDir: boolean,
): TestApp {
  let closed = false;

  const mainPage = async (): Promise<Page> => {
    // The first window Electron creates IS the main window (FloatingHudWindow
    // is constructed after but its `show: true` is gated). In production the
    // main window is also the only window the user sees pre-onboarding.
    const pages = electronApp.windows();
    let main: Page | undefined;
    if (pages.length > 0) {
      // Pick the first non-HUD window — main HTML loads `index.html`, HUD
      // loads `hud.html`. URL is the cleanest discriminator.
      main = pages.find((p) => !p.url().includes('hud.html'));
    }
    if (!main) {
      main = await electronApp.waitForEvent('window', {
        predicate: (p) => !p.url().includes('hud.html'),
      });
    }
    installSlowMo(main);
    return main;
  };

  const hudPage = async (timeoutMs = 10_000): Promise<Page> => {
    const existing = electronApp.windows().find((p) => p.url().includes('hud.html'));
    if (existing) return existing;
    return await electronApp.waitForEvent('window', {
      timeout: timeoutMs,
      predicate: (p) => p.url().includes('hud.html'),
    });
  };

  const setPermission = async (kind: PermissionKind, grant: PermissionGrant) => {
    await electronApp.evaluate(({}, args) => {
      const e2e = (globalThis as unknown as {
        __e2e?: {
          permissions: { set(k: string, g: string): void };
        };
      }).__e2e;
      if (!e2e) throw new Error('__e2e hook not registered — TWINMIND_E2E=1?');
      e2e.permissions.set(args.kind, args.grant);
    }, { kind, grant });
  };

  const deliverAuthCallback = async (url: string) => {
    await electronApp.evaluate(({}, args) => {
      const e2e = (globalThis as unknown as {
        __e2e?: { deliverAuthCallback(u: string): void };
      }).__e2e;
      if (!e2e) throw new Error('__e2e hook not registered — TWINMIND_E2E=1?');
      e2e.deliverAuthCallback(args.url);
    }, { url });
  };

  const waitForLastAuthBrowserUrl = async (timeoutMs = 15_000): Promise<string> => {
    const deadline = Date.now() + timeoutMs;
    let url: string | null = null;
    while (Date.now() < deadline) {
      url = await electronApp.evaluate(() => {
        const e2e = (globalThis as unknown as {
          __e2e?: { getLastAuthBrowserUrl(): string | null };
        }).__e2e;
        return e2e?.getLastAuthBrowserUrl() ?? null;
      });
      if (url) return url;
      await delay(150);
    }
    throw new Error(`waitForLastAuthBrowserUrl: no URL within ${timeoutMs}ms`);
  };

  const diagnostics = async (): Promise<E2EDiagnostics> => {
    return await electronApp.evaluate(() => {
      const e2e = (globalThis as unknown as {
        __e2e?: { diagnostics(): unknown };
      }).__e2e;
      if (!e2e) throw new Error('__e2e hook not registered — TWINMIND_E2E=1?');
      return e2e.diagnostics();
    }) as E2EDiagnostics;
  };

  const clearLastAuthBrowserUrl = async (): Promise<void> => {
    await electronApp.evaluate(() => {
      const e2e = (globalThis as unknown as {
        __e2e?: { clearLastAuthBrowserUrl(): void };
      }).__e2e;
      e2e?.clearLastAuthBrowserUrl();
    });
  };

  const signIn = async (signInOpts: SignInOptions = {}): Promise<void> => {
    const secret = signInOpts.secret ?? process.env.TWINMIND_E2E_TEST_SECRET;
    if (!secret) {
      throw new Error(
        'app.signIn: TWINMIND_E2E_TEST_SECRET is not set. Add it to .env.test or pass opts.secret.',
      );
    }

    // Pre-flight: ensure the auth provider isn't sitting on a stale URL from
    // a prior aborted sign-in attempt in the same process.
    await clearLastAuthBrowserUrl();

    const main = await mainPage();
    // Click but don't await — auth.signIn() pends until the callback lands,
    // and we're the ones delivering it below.
    void main
      .getByTestId('sign-in-button')
      .click()
      .catch(() => {
        /* may race with re-render; the resulting auth.signIn IPC fired */
      });

    const url = signInOpts.signInUrl ?? (await waitForLastAuthBrowserUrl());
    const callbackUrl = await captureDevSignInCallback({
      signInUrl: url,
      testSecret: secret,
      headed: signInOpts.headed,
      vercelProtectionBypass: process.env.VERCEL_PROTECTION_BYPASS ?? null,
    });
    await deliverAuthCallback(callbackUrl);

    // Wait for the auth provider to finish exchanging the code → ID + refresh
    // tokens. Up to 20s — Firebase REST round-trip is typically <1s but a
    // cold staging deploy can stall longer.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const d = await diagnostics();
      if (d.auth.isAuthenticated) return;
      await delay(150);
    }
    throw new Error('app.signIn: auth state never flipped to authenticated within 20s');
  };

  const completeWizard = async (): Promise<void> => {
    await electronApp.evaluate(() => {
      const e2e = (globalThis as unknown as {
        __e2e?: { completeWizard(): void };
      }).__e2e;
      if (!e2e) throw new Error('__e2e hook not registered — TWINMIND_E2E=1?');
      e2e.completeWizard();
    });
  };

  const forceUpdateReady = async (version: string): Promise<void> => {
    await electronApp.evaluate(({}, args) => {
      const e2e = (globalThis as unknown as {
        __e2e?: { forceUpdateReady(v: string): void };
      }).__e2e;
      if (!e2e) throw new Error('__e2e hook not registered — TWINMIND_E2E=1?');
      e2e.forceUpdateReady(args.version);
    }, { version });
  };

  const walkOnboardingWizard = async (): Promise<void> => {
    const main = await mainPage();
    // Permissions are pre-granted in e2e mode, so only the Continue
    // (secondary) buttons render — see B1 spec for the rationale.
    await main.getByTestId('onboarding-welcome-next').click();
    await main.getByTestId('onboarding-mic-next').click();
    await main.getByTestId('onboarding-audiocap-next').click();
    await main.getByTestId('onboarding-accessibility-next').click();
    await main.getByTestId('onboarding-notifications-next').click();
    await main.getByTestId('onboarding-done-button').click();
  };

  const relaunch = async (
    relaunchOpts: { env?: Record<string, string | undefined> } = {},
  ): Promise<TestApp> => {
    // Close cleanly; do NOT delete the userData dir — we're handing it off.
    await electronApp.close().catch(() => {});
    return launchApp({
      userDataDir,
      env: relaunchOpts.env,
    });
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await electronApp.close();
    } catch {
      /* already exited */
    }
    if (ownsUserDataDir) {
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  };

  return {
    electronApp,
    userDataDir,
    mainPage,
    hudPage,
    setPermission,
    deliverAuthCallback,
    waitForLastAuthBrowserUrl,
    diagnostics,
    signIn,
    completeWizard,
    walkOnboardingWizard,
    forceUpdateReady,
    relaunch,
    close,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
