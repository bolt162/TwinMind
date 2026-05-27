/**
 * Dev-environment sign-in helper.
 *
 * The TwinMind dev webapp (dev.app.twinmind.com) exposes a "Test user
 * secret" password field on the same `/login?via_desktop` page the production
 * webapp uses for Google OAuth. Filling that field and submitting causes the
 * dev backend to mint a one-shot handoff token and redirect to
 * `twinmind://auth/callback?token=…` — exactly like a successful Google
 * OAuth would. We capture that URL with Playwright's request/navigation
 * listeners and hand it back to the e2e fixture for delivery to the app.
 *
 * Why no Google OAuth: 2FA, reCAPTCHA, and headless detection make Google's
 * sign-in fragile in CI. The dev-only password path is the same final
 * shape (same redirect, same token semantics) without any of those risks.
 *
 * Inputs:
 *   - `signInUrl`: the URL `app.signIn()` captured from `globalThis.__e2eLastAuthBrowserUrl`.
 *   - `testSecret`: the dev password, from `process.env.TWINMIND_E2E_TEST_SECRET`.
 *
 * Output: the captured `twinmind://…` URL. Caller passes it to
 * `app.deliverAuthCallback(url)` which re-enters the main process as if
 * macOS LaunchServices had routed it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser } from '@playwright/test';

export interface CaptureOpts {
  /** The URL the TwinMindAuthProvider asked to open in the browser. */
  readonly signInUrl: string;
  /** Value to put in the `data-testid="test-user-secret-input"` field. */
  readonly testSecret: string;
  /**
   * Watch headed for debugging — flip `TWINMIND_E2E_HEADED=1` before running
   * to see the dev webapp drive itself. Off in CI.
   */
  readonly headed?: boolean;
  /** How long to wait for the twinmind:// callback to fire. */
  readonly timeoutMs?: number;
  /**
   * Vercel Protection Bypass header value if the dev webapp is gated. Sent
   * as `x-vercel-protection-bypass` on every navigation.
   */
  readonly vercelProtectionBypass?: string | null;
}

/** Match: `twinmind://auth/callback?token=...` (or any twinmind:// URL). */
function isTwinMindCallback(url: string): boolean {
  return url.startsWith('twinmind://');
}

/**
 * Drive the dev sign-in page in a fresh Chromium context and return the
 * `twinmind://` callback URL.
 *
 * The Chromium context is disposed before this function returns; the caller
 * does not need to clean anything up.
 */
export async function captureDevSignInCallback(opts: CaptureOpts): Promise<string> {
  if (!opts.testSecret) {
    throw new Error(
      'captureDevSignInCallback: testSecret is empty — set TWINMIND_E2E_TEST_SECRET in .env.test',
    );
  }

  // Honor the same slow-mo knob the Electron fixture reads — the dev
  // webapp's password-submit dance is the most useful place to watch a
  // failing sign-in step by step.
  const slowMo = (() => {
    const v = parseInt(process.env.TWINMIND_E2E_SLOWMO ?? '0', 10);
    return Number.isFinite(v) && v > 0 ? v : 0;
  })();

  const browser: Browser = await chromium.launch({
    headless: !(opts.headed || process.env.TWINMIND_E2E_HEADED === '1'),
    slowMo,
  });
  try {
    // NOTE on Vercel Protection Bypass: do NOT set it as a context-wide
    // header. The dev webapp calls Firebase REST from the browser
    // (identitytoolkit.googleapis.com → signInWithCustomToken), and
    // attaching a custom header turns the cross-origin Firebase request
    // into a CORS-preflighted one — Firebase doesn't whitelist the bypass
    // header, the preflight fails, Firebase SDK reports
    // `auth/network-request-failed`, and the webapp never redirects to
    // `twinmind://`. Use Vercel's query-param flow instead: the bypass
    // token rides as `?x-vercel-protection-bypass=...&x-vercel-set-bypass-cookie=true`
    // on the initial navigation; Vercel drops a `_vercel_jwt` cookie that
    // covers subsequent same-origin requests. Cross-origin Firebase calls
    // never see the cookie or header → no CORS preflight.
    const context = await browser.newContext();
    const page = await context.newPage();

    // Trace all navigations + non-2xx responses so a stuck flow can be
    // diagnosed after the timeout. Filtered to the main frame to avoid
    // analytics / asset chatter dominating the log.
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) console.info(`[oauth] framenavigated: ${f.url()}`);
    });
    page.on('response', (r) => {
      const status = r.status();
      if (status >= 300 && r.frame() === page.mainFrame()) {
        console.info(`[oauth] response: ${status} ${r.url()}`);
      }
    });
    page.on('pageerror', (e) => console.info(`[oauth] pageerror: ${e.message}`));
    page.on('console', (m) => {
      const t = m.type();
      if (t === 'error' || t === 'warning') console.info(`[oauth] page-${t}: ${m.text()}`);
    });

    // Set up the capture BEFORE submitting the form so we never race the
    // browser's attempt to navigate to twinmind://. Both `request` (catches
    // the navigation attempt) and `framenavigated` (catches the URL bar
    // update if the request was blocked at the network layer) feed the same
    // promise; whichever fires first wins.
    const captured = new Promise<string>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? 30_000;
      const timeout = setTimeout(async () => {
        // Same diagnostic dump as the field-not-found path so we can see
        // why the form didn't trigger the expected redirect (wrong secret,
        // inline error, alternate redirect path, …).
        const dumpDir = path.join(process.cwd(), 'test-results', 'oauth-failure');
        fs.mkdirSync(dumpDir, { recursive: true });
        const screenshotPath = path.join(dumpDir, `post-submit-${Date.now()}.png`);
        const htmlPath = path.join(dumpDir, `post-submit-${Date.now()}.html`);
        try {
          await page.screenshot({ path: screenshotPath, fullPage: true });
          fs.writeFileSync(htmlPath, await page.content());
        } catch {
          /* best-effort */
        }
        const bodyText = await page
          .evaluate(() => document.body?.innerText?.slice(0, 1200) ?? '')
          .catch(() => '');
        reject(
          new Error(
            `captureDevSignInCallback: timed out waiting for twinmind:// callback after ${timeoutMs}ms.\n` +
              `  current URL: ${page.url()}\n` +
              `  body (first 1200 chars): ${bodyText.replace(/\s+/g, ' ').slice(0, 1200)}\n` +
              `  screenshot: ${screenshotPath}\n` +
              `  html:       ${htmlPath}`,
          ),
        );
      }, timeoutMs);
      const tryMatch = (url: string) => {
        if (isTwinMindCallback(url)) {
          clearTimeout(timeout);
          resolve(url);
        }
      };
      page.on('request', (r) => tryMatch(r.url()));
      page.on('framenavigated', (f) => {
        if (f === page.mainFrame()) tryMatch(f.url());
      });
    });

    // Append the Vercel bypass to the URL (not as a header — see context
    // creation above for why). When VERCEL_PROTECTION_BYPASS is empty the
    // URL is unchanged and the navigation proceeds without the bypass.
    const navigateUrl = (() => {
      const bypass = opts.vercelProtectionBypass?.trim() ?? '';
      if (bypass.length === 0) return opts.signInUrl;
      const u = new URL(opts.signInUrl);
      u.searchParams.set('x-vercel-protection-bypass', bypass);
      u.searchParams.set('x-vercel-set-bypass-cookie', 'true');
      return u.toString();
    })();

    // Navigate to the dev login page. `domcontentloaded` is enough — the
    // password field doesn't need every asset, and waiting for `load` adds
    // ~1s of latency on the typical fonts-and-analytics page weight.
    const response = await page.goto(navigateUrl, { waitUntil: 'domcontentloaded' });
    console.info(
      `[oauth] navigated to ${navigateUrl} → ${response?.status() ?? '?'} ${response?.statusText() ?? ''} (final URL: ${page.url()})`,
    );

    // The dev webapp renders the form TWICE in DOM — one variant for the
    // desktop layout (`hidden lg:flex` container), one for mobile
    // (`flex lg:hidden`). Both inputs share `data-testid="test-user-secret-input"`.
    // The `:visible` pseudo-class narrows to whichever variant the current
    // viewport actually shows, avoiding the multi-match ambiguity.
    const input = page.locator('[data-testid="test-user-secret-input"]:visible');
    try {
      await input.waitFor({ state: 'visible', timeout: 10_000 });
    } catch {
      // Capture page state to disk so the user can inspect what loaded
      // instead of the expected form. Lands next to Playwright's own
      // test-results artifacts.
      const dumpDir = path.join(process.cwd(), 'test-results', 'oauth-failure');
      fs.mkdirSync(dumpDir, { recursive: true });
      const screenshotPath = path.join(dumpDir, `dev-page-${Date.now()}.png`);
      const htmlPath = path.join(dumpDir, `dev-page-${Date.now()}.html`);
      try {
        await page.screenshot({ path: screenshotPath, fullPage: true });
        fs.writeFileSync(htmlPath, await page.content());
      } catch {
        /* best-effort diagnostic */
      }
      const pageTitle = await page.title().catch(() => '');
      const bodyText = await page
        .evaluate(() => document.body?.innerText?.slice(0, 800) ?? '')
        .catch(() => '');
      throw new Error(
        `captureDevSignInCallback: [data-testid="test-user-secret-input"] not visible at ${opts.signInUrl}.\n` +
          `  HTTP: ${response?.status() ?? '?'} ${response?.statusText() ?? ''}\n` +
          `  final URL: ${page.url()}\n` +
          `  page title: ${pageTitle || '(empty)'}\n` +
          `  body (first 800 chars): ${bodyText.replace(/\s+/g, ' ').slice(0, 800)}\n` +
          `  screenshot: ${screenshotPath}\n` +
          `  html:       ${htmlPath}`,
      );
    }
    await input.fill(opts.testSecret);
    // The submit button (data-testid="test-user-button") starts `disabled`
    // and only enables once the input has text. Clicking it is more
    // deterministic than pressing Enter, which the disabled-button gates.
    // Use `:visible` for the same desktop/mobile disambiguation as above.
    const submit = page.locator('[data-testid="test-user-button"]:visible');
    await submit.waitFor({ state: 'visible', timeout: 5_000 });
    await submit.click();

    return await captured;
  } finally {
    await browser.close();
  }
}
