/**
 * Phase 8 — Auto-updater happy path (H1).
 *
 * The packaged-only `electron-updater` flow is disabled in our e2e launches
 * (`app.isPackaged` is false when running `_electron.launch(['main.js'])`),
 * so we force the UpdateService into `ready` state via the `forceUpdateReady`
 * e2e hook. The renderer's UpdateBanner is gated purely on
 * `state.phase === 'ready'`, so it mounts the moment we push that state.
 *
 * Clicking Restart & Update calls `quitAndInstall`, which in disabled
 * mode short-circuits to `{ ok: false, error: 'not_ready' }` — the click
 * is acknowledged and the banner stays put, no app quit. We just assert
 * the banner is present + the button is enabled + clickable. The
 * actually-quits flow can only be tested in a packaged build (which the
 * release pipeline verifies manually per the auto-update plan in
 * temp.md).
 */

import { test, expect } from './fixtures/test';

const HAS_SECRET = !!process.env.TWINMIND_E2E_TEST_SECRET;

test.beforeEach(({}, testInfo) => {
  test.skip(!HAS_SECRET, 'TWINMIND_E2E_TEST_SECRET not set');
});

test('H1 update banner appears with the forced version and is clickable', async ({ app }) => {
  await app.completeWizard();
  await app.signIn();
  const main = await app.mainPage();

  // The renderer should land on Home (tab-recording) by default. Confirm
  // the banner is NOT there before we force ready — sanity check the gate.
  await expect(main.getByTestId('update-banner')).toHaveCount(0);

  await app.forceUpdateReady('1.0.99');

  // After forceUpdateReady the broadcast lands; the banner mounts.
  const banner = main.getByTestId('update-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute('data-update-version', '1.0.99');
  await expect(banner).toContainText('1.0.99');

  // Install button is enabled (no recording active, no submit in flight).
  const installButton = main.getByTestId('update-install-button');
  await expect(installButton).toBeEnabled();
  // Click is accepted; in disabled-mode `quitAndInstall` returns `not_ready`
  // and the renderer flips `submitting` back to false. No app quit.
  await installButton.click();
  await expect(installButton).toBeEnabled();
});
