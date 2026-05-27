/**
 * Phase 1 smoke spec — proves the e2e harness boots Electron, the renderer
 * mounts against a fresh userData dir, and the sign-in screen is what greets
 * an unauthenticated user. No Google creds required.
 */

import { test, expect } from './fixtures/test';

test('boots to the sign-in screen on a fresh userData dir', async ({ app }) => {
  const main = await app.mainPage();
  // SignInScreen's root carries data-testid="sign-in-screen".
  await expect(main.getByTestId('sign-in-screen')).toBeVisible();
  await expect(main.getByTestId('sign-in-button')).toBeVisible();

  // Diagnostics confirm we are pre-auth and no per-user app is composed.
  const diag = await app.diagnostics();
  expect(diag.auth.isAuthenticated).toBe(false);
  expect(diag.auth.userId).toBeNull();
  expect(diag.composedUserId).toBeNull();
  expect(diag.orchestrator.state).toBe('idle');
});

test('e2e permission hook is wired and mutable', async ({ app }) => {
  // FakePermissionService defaults every kind to "granted" in e2e mode so
  // the wizard flows naturally; we toggle one and assert the snapshot
  // reflects it. Proves the globalThis hook + evaluate() round-trip works.
  await app.setPermission('mic', 'denied');
  const diag = await app.diagnostics();
  expect(diag.permissions.mic).toBe('denied');
  expect(diag.permissions.audioCapture).toBe('granted');
});
