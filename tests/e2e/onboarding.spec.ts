/**
 * Phase 3 — Onboarding wizard happy paths (B1, B2).
 *
 * Both specs require sign-in. In e2e mode FakePermissionService is seeded
 * with every permission already 'granted' (see `buildPlatformServices` in
 * src/main.ts), so each wizard step's Continue button renders and clicking
 * it advances the FSM. The Grant buttons may briefly appear before the
 * step's 1s permission poll syncs the React state — we don't click them;
 * we just click Continue, which is testid-stable regardless.
 *
 * Skips if `TWINMIND_E2E_TEST_SECRET` isn't set (same as auth specs).
 */

import { test, expect } from './fixtures/test';

const HAS_SECRET = !!process.env.TWINMIND_E2E_TEST_SECRET;

test.beforeEach(({}, testInfo) => {
  test.skip(
    !HAS_SECRET,
    'TWINMIND_E2E_TEST_SECRET not set — copy .env.test.example to .env.test and fill the dev test secret',
  );
});

test('B1 walks every wizard step → main app + visible HUD', async ({ app }) => {
  await app.signIn();

  const main = await app.mainPage();
  const wizard = main.getByTestId('onboarding-flow');

  // Land on the welcome step.
  await expect(wizard).toBeVisible();
  await expect(wizard).toHaveAttribute('data-onboarding-step', 'welcome');

  // Welcome → mic.
  await main.getByTestId('onboarding-welcome-next').click();
  await expect(wizard).toHaveAttribute('data-onboarding-step', 'mic');

  // Mic → audioCapture. FakePermissionService already reports granted; the
  // step's Continue button is the one we want regardless of the brief
  // pre-poll "not_determined" flash.
  await main.getByTestId('onboarding-mic-next').click();
  await expect(wizard).toHaveAttribute('data-onboarding-step', 'audioCapture');

  // audioCapture → accessibility.
  await main.getByTestId('onboarding-audiocap-next').click();
  await expect(wizard).toHaveAttribute('data-onboarding-step', 'accessibility');

  // accessibility → notifications.
  await main.getByTestId('onboarding-accessibility-next').click();
  await expect(wizard).toHaveAttribute('data-onboarding-step', 'notifications');

  // notifications → done.
  await main.getByTestId('onboarding-notifications-next').click();
  await expect(wizard).toHaveAttribute('data-onboarding-step', 'done');

  // Done → main app.
  await main.getByTestId('onboarding-done-button').click();
  await expect(main.getByTestId('app-layout')).toBeVisible();
  await expect(main.getByTestId('onboarding-flow')).toHaveCount(0);

  // Initial tab is Recording (per App.tsx useState default).
  await expect(main.getByTestId('tab-recording')).toHaveAttribute('data-active', 'true');

  // HUD reveals after wizard.complete (FloatingHudWindow.revealOnActiveDisplay).
  // BrowserWindow.isVisible() is the authoritative signal — the window
  // exists from boot but is hidden until onboardingComplete flips.
  const hudVisible = await app.electronApp.evaluate(({ BrowserWindow }) => {
    return BrowserWindow.getAllWindows().some((w) => {
      try {
        return w.isVisible() && w.webContents.getURL().includes('hud.html');
      } catch {
        return false;
      }
    });
  });
  expect(hudVisible).toBe(true);
});

test('B2 wizard does not re-run on subsequent sign-ins (same machine)', async ({ app }) => {
  // First sign-in lands on the wizard (fresh userData dir).
  await app.signIn();
  const main = await app.mainPage();
  await expect(main.getByTestId('onboarding-flow')).toBeVisible();

  // Walk through the wizard UI so the renderer re-routes to the main
  // layout. We can't shortcut this with `completeWizard()` here — that
  // only writes the DB flag, but the renderer's wizardDone state is
  // already false and won't re-check without another auth-state change.
  await app.walkOnboardingWizard();
  await expect(main.getByTestId('app-layout')).toBeVisible();

  // Sign out from Settings.
  await main.getByTestId('tab-settings').click();
  await main.getByTestId('sign-out-button').click();
  await expect(main.getByTestId('sign-in-screen')).toBeVisible();

  // Sign back in. globalDb.onboarding_completed_at survives across
  // sign-outs because it is machine-scoped, not user-scoped — so App.tsx
  // should skip OnboardingFlow this time.
  await app.signIn();
  await expect(main.getByTestId('app-layout')).toBeVisible();
  await expect(main.getByTestId('onboarding-flow')).toHaveCount(0);
});
