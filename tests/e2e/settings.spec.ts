/**
 * Phase 4 — Settings happy paths (C1, C2).
 *
 * Both specs pre-complete the wizard so the renderer lands on the main
 * layout immediately post-sign-in (see auth.spec.ts A2 for the rationale —
 * completeWizard() before signIn()).
 */

import { test, expect } from './fixtures/test';

const HAS_SECRET = !!process.env.TWINMIND_E2E_TEST_SECRET;

test.beforeEach(({}, testInfo) => {
  test.skip(!HAS_SECRET, 'TWINMIND_E2E_TEST_SECRET not set');
});

test('C1 toggle persists across tab navigation', async ({ app }) => {
  await app.completeWizard();
  await app.signIn();

  const main = await app.mainPage();
  await main.getByTestId('tab-settings').click();

  const enabledToggle = main.getByTestId('settings-meeting-detect-enabled');
  const autostartToggle = main.getByTestId('settings-meeting-detect-autostart');

  // Defaults per SettingsStore: enabled=true, autoStart=false. SettingsPage
  // mirrors the underlying state via aria-checked on the role=switch button.
  await expect(enabledToggle).toHaveAttribute('aria-checked', 'true');
  await expect(autostartToggle).toHaveAttribute('aria-checked', 'false');

  // Flip both.
  await enabledToggle.click();
  await autostartToggle.click();
  await expect(enabledToggle).toHaveAttribute('aria-checked', 'false');
  await expect(autostartToggle).toHaveAttribute('aria-checked', 'true');

  // Navigate away (forces SettingsPage to unmount), then back.
  await main.getByTestId('tab-recording').click();
  await expect(main.getByTestId('tab-recording')).toHaveAttribute('data-active', 'true');
  await main.getByTestId('tab-settings').click();

  // SettingsPage re-mounts, useSettings hook re-fetches via SETTINGS_GET.
  // Toggles should reflect the saved state from the previous click cycle.
  await expect(main.getByTestId('settings-meeting-detect-enabled')).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await expect(main.getByTestId('settings-meeting-detect-autostart')).toHaveAttribute(
    'aria-checked',
    'true',
  );
});

test('C2 changing hotkey via settings updates the Home page hint', async ({ app }) => {
  await app.completeWizard();
  await app.signIn();

  const main = await app.mainPage();
  // App lands on the Recording tab (Home) by default — assert the initial
  // hotkey label is the "🌐 Fn" default (matches SettingsStore default
  // hotkeys.primary = null, which useHotkeyLabel renders as 🌐 Fn).
  const label = main.getByTestId('home-hotkey-label');
  await expect(label).toBeVisible();
  await expect(label).toHaveText('🌐 Fn');

  // Programmatically set a new hotkey via the existing SETTINGS_SET IPC.
  // We skip the HotkeyCaptureField UI here — capturing native key events
  // requires injecting at the OS level, which Playwright can't do for
  // macOS Fn/Globe. Driving the renderer-side propagation is what this
  // spec asserts; the capture mechanics are unit-tested by
  // HotkeyGestureRecognizer.
  await main.evaluate(async () => {
    const current = await window.electronAPI.settings.get();
    const next = {
      ...(current as Record<string, unknown>),
      hotkeys: {
        ...((current as { hotkeys?: Record<string, unknown> }).hotkeys ?? {}),
        primary: {
          modifiers: ['MetaLeft', 'ShiftLeft'],
          key: { code: 'KeyD', display: 'D' },
        },
      },
    };
    await window.electronAPI.settings.set(next as Parameters<typeof window.electronAPI.settings.set>[0]);
  });

  // Main broadcasts HOTKEY_CHANGED after writing — the Home page's
  // useHotkeyLabel hook subscribes to that push and re-formats the label.
  // formatHotkey distinguishes left/right modifiers explicitly:
  // { MetaLeft, ShiftLeft, KeyD } → "Left ⌘ + Left ⇧ + D".
  await expect(label).toHaveText('Left ⌘ + Left ⇧ + D');
});
