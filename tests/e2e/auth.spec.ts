/**
 * Phase 2 — Auth happy paths (A1, A2, A3).
 *
 * Uses the dev webapp's "Test user secret" sign-in field instead of real
 * Google OAuth. The OAuth helper drives that field in a separate Chromium
 * context and captures the `twinmind://auth/callback?token=…` redirect.
 *
 * Each spec skips automatically if `.env.test` doesn't set the secret.
 * Set `TWINMIND_E2E_TEST_SECRET` in `.env.test` and ensure your `.env` is
 * pointed at the dev environment — backend URLs + Firebase config are
 * baked into the bundle at build time from `.env`, not read at runtime.
 */

import { test, expect } from './fixtures/test';
import { launchApp } from './fixtures/app';

const HAS_SECRET = !!process.env.TWINMIND_E2E_TEST_SECRET;

test.beforeEach(({}, testInfo) => {
  test.skip(
    !HAS_SECRET,
    'TWINMIND_E2E_TEST_SECRET not set — copy .env.test.example to .env.test and fill the dev test secret',
  );
});

test('A1 cold sign-in lands on the onboarding wizard', async ({ app }) => {
  const main = await app.mainPage();
  await expect(main.getByTestId('sign-in-screen')).toBeVisible();

  await app.signIn();

  // Auth state flipped — App.tsx re-routes off SignInScreen. On a fresh
  // userData dir the wizard hasn't completed yet, so OnboardingFlow mounts.
  await expect(main.getByTestId('onboarding-flow')).toBeVisible();
  await expect(main.getByTestId('sign-in-screen')).toHaveCount(0);

  const diag = await app.diagnostics();
  expect(diag.auth.isAuthenticated).toBe(true);
  expect(diag.auth.userEmail).toBeTruthy();
  expect(diag.composedUserId).toBe(diag.auth.userId);
});

test('A2 sign-out from Settings returns to the sign-in screen', async ({ app }) => {
  // Pre-complete the wizard BEFORE sign-in. App.tsx fetches wizard status
  // exactly once on each auth-state change, so the flag must be set before
  // signIn() lands or the renderer will still mount OnboardingFlow (and
  // tab-settings won't exist yet). A2 is about the sign-out flow; the
  // wizard flow is covered by B1.
  await app.completeWizard();
  await app.signIn();

  const main = await app.mainPage();
  await expect(main.getByTestId('app-layout')).toBeVisible();
  await main.getByTestId('tab-settings').click();
  await main.getByTestId('sign-out-button').click();

  // Auth state flips back; App.tsx re-renders SignInScreen.
  await expect(main.getByTestId('sign-in-screen')).toBeVisible();
  const diag = await app.diagnostics();
  expect(diag.auth.isAuthenticated).toBe(false);
  expect(diag.composedUserId).toBeNull();
});

test('A3 relaunch with persisted credentials skips the sign-in screen', async ({}, testInfo) => {
  // This spec manages its own app lifetime so the same userData dir survives
  // across two launches. The auto-fixture would tear the dir down between
  // them. `keepUserDataDir: true` on the first launch defers cleanup; the
  // second launch (via relaunch) owns the dir and cleans up on its close.
  const first = await launchApp({ keepUserDataDir: true });
  try {
    await first.signIn();
    await first.completeWizard();
    const diag1 = await first.diagnostics();
    expect(diag1.auth.isAuthenticated).toBe(true);

    const second = await first.relaunch();
    try {
      const mainAfter = await second.mainPage();
      // The auth provider rehydrates from globalDb + secureStorage before
      // App.tsx asks for getState(), so SignInScreen should never mount.
      await expect(mainAfter.getByTestId('app-layout')).toBeVisible();
      await expect(mainAfter.getByTestId('sign-in-screen')).toHaveCount(0);

      const diag2 = await second.diagnostics();
      expect(diag2.auth.isAuthenticated).toBe(true);
      expect(diag2.auth.userId).toBe(diag1.auth.userId);
      expect(diag2.composedUserId).toBe(diag1.auth.userId);
    } finally {
      await second.close();
    }
  } finally {
    // First instance is already closed by relaunch(); only the userDataDir
    // dir needs disposal, which `second.close()` handled above.
    await first.close().catch(() => {});
  }
});
