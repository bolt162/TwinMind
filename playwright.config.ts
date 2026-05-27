/**
 * Playwright config for TwinMind e2e tests.
 *
 * Single project that drives the packaged Electron app via
 * `_electron.launch()`. Each spec gets a tmp `userData` dir so DB / Keychain
 * state never leaks between runs or into the user's real install.
 *
 * Before running: `npm run build:e2e` (alias for build:main + build:renderer)
 * — Playwright launches Electron against `dist/main/main.js` and loads the
 * renderer from `dist/renderer/index.html` like the packaged DMG does.
 *
 * Required env (loaded from `.env.test` via dotenv in the fixture):
 *   TWINMIND_FIREBASE_API_KEY, TWINMIND_AUTH_EXCHANGE_URL, etc — the same
 *     backend vars production reads, pointed at a test environment.
 *   TWINMIND_E2E_GOOGLE_EMAIL, TWINMIND_E2E_GOOGLE_PASSWORD — credentials
 *     for the throwaway Google account driving real OAuth.
 *
 * The auth helper assumes 2FA is OFF on the test account. If you need 2FA,
 * swap to a long-lived `storageState.json` checked into the repo (encrypted)
 * — see `tests/e2e/fixtures/auth.ts` for the hook point.
 */

import path from 'node:path';
import dotenv from 'dotenv';
import { defineConfig } from '@playwright/test';

// Load `.env.test` AT CONFIG LOAD so every spec file's top-level
// `process.env.TWINMIND_E2E_TEST_SECRET` check resolves before module
// evaluation. The fixture in tests/e2e/fixtures/app.ts loads it again
// for the Electron-process env — both calls are no-ops on already-set
// vars, so the order is harmless.
dotenv.config({ path: path.join(__dirname, '.env.test') });

/**
 * When TWINMIND_E2E_SLOWMO=<ms> is set (typical: 3000 for "watch each
 * click for 3 s"), every action gets a post-action pause via the
 * Locator/Page monkey-patch in fixtures/app.ts. The per-test and
 * expect timeouts have to grow with it — at slowMo=3000 a 10-click
 * spec accumulates 30 s of pure delay before any real work counts.
 */
const SLOWMO_MS = (() => {
  const v = parseInt(process.env.TWINMIND_E2E_SLOWMO ?? '0', 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
})();
const IS_SLOWMO = SLOWMO_MS > 0;

export default defineConfig({
  testDir: './tests/e2e',
  // OAuth + Electron boot are inherently slow; 90 s per test covers cold
  // sign-in with browser handoff. Most non-auth tests complete in < 5 s.
  // In slow-mo mode (humans watching) we extend generously since the user
  // is inspecting, not benchmarking.
  timeout: IS_SLOWMO ? 600_000 : 90_000,
  expect: {
    // UI assertions poll up to 20 s — covers state-machine transitions
    // (recording → processing → idle), IPC roundtrips after tab switches,
    // and the chunk-encode → upload → DB → list-refresh chain. 20 s is
    // generous on a fast run (assertions resolve in ms when state is
    // correct) but absorbs the back-to-back-launch jitter we see when
    // every spec spawns a fresh Electron process. Slow-mo bumps it.
    timeout: IS_SLOWMO ? 60_000 : 20_000,
  },
  // Serial by default. The native CoreAudio addon and the audio-process
  // utility hold OS-scoped resources that don't parallelize cleanly across
  // multiple Electron instances on the same machine. Bump workers manually
  // for read-only specs (smoke, sign-in screen rendering) if needed.
  workers: 1,
  fullyParallel: false,
  // CI: fail fast on the first broken spec. Local: keep going so a single
  // flake doesn't hide the rest of the suite.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'electron',
      testMatch: /.*\.spec\.ts/,
    },
  ],
});
