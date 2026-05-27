/**
 * Phase 5 — HUD happy paths (D1, D2).
 *
 * D1 exercises the drag IPC chain (begin → dragMoveBy → end) and asserts
 * the BrowserWindow bounds actually shifted. D2 starts/stops a meeting via
 * IPC and asserts the HUD pill's data-* attributes transition through the
 * expected visual states. Both rely on the `hud-pill`, `data-hud-visual`,
 * `data-hud-mode`, and `data-hud-recording` testids added in Phase 1.
 */

import { test, expect } from './fixtures/test';

const HAS_SECRET = !!process.env.TWINMIND_E2E_TEST_SECRET;

test.beforeEach(({}, testInfo) => {
  test.skip(!HAS_SECRET, 'TWINMIND_E2E_TEST_SECRET not set');
});

test('D1 drag shifts HUD window bounds via IPC', async ({ app }) => {
  await app.completeWizard();
  await app.signIn();

  const hud = await app.hudPage();

  // Snapshot initial bounds via electronApp.evaluate so we read the actual
  // BrowserWindow geometry (not what the renderer thinks it is).
  const initialBounds = await app.electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => {
      try {
        return w.webContents.getURL().includes('hud.html');
      } catch {
        return false;
      }
    });
    return win?.getBounds() ?? null;
  });
  expect(initialBounds, 'HUD BrowserWindow should exist after sign-in').not.toBeNull();

  // Drive the same IPC sequence the HUD's pill mouse-handler fires. Small
  // offsets (60, -40) so the clamp in FloatingHudWindow doesn't pin us to
  // an edge regardless of where the workArea sits.
  await hud.evaluate(async () => {
    await window.electronAPI.hud.beginDrag();
    await window.electronAPI.hud.dragMoveBy({ dx: 60, dy: -40 });
    await window.electronAPI.hud.endDrag();
  });

  const newBounds = await app.electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => {
      try {
        return w.webContents.getURL().includes('hud.html');
      } catch {
        return false;
      }
    });
    return win?.getBounds() ?? null;
  });
  expect(newBounds).not.toBeNull();

  // The OS may round subpixel deltas; we just assert the position moved in
  // each axis — exact arithmetic against (60, -40) would over-constrain if
  // clamping kicked in at the edge of workArea.
  expect(newBounds!.x).not.toBe(initialBounds!.x);
  expect(newBounds!.y).not.toBe(initialBounds!.y);
});

test('D2 HUD pill transitions through recording states for a meeting', async ({ app }) => {
  await app.completeWizard();
  await app.signIn();

  const main = await app.mainPage();
  const hud = await app.hudPage();
  const pill = hud.getByTestId('hud-pill');

  // Pre-recording: pill is idle.
  await expect(pill).toHaveAttribute('data-hud-recording', 'idle');
  await expect(pill).toHaveAttribute('data-hud-visual', 'idle');

  // Start a meeting via the same IPC the HUD's "Capture Notes" button fires.
  // Driving it from main page rather than HUD page sidesteps the HUD's
  // click-through hit-testing (the HUD is transparent and its mouse-ignore
  // toggling makes button clicks flaky to drive from Playwright directly).
  await main.evaluate(async () => {
    await window.electronAPI.recording.startMeeting();
  });

  // The orchestrator transitions starting → recording. The HUD subscribes
  // to RECORDING_STATE_CHANGED and updates `data-hud-*` attributes. Visual
  // priority puts 'recording' on top once the orchestrator settles there.
  await expect(pill).toHaveAttribute('data-hud-recording', 'recording');
  await expect(pill).toHaveAttribute('data-hud-mode', 'meeting');
  await expect(pill).toHaveAttribute('data-hud-visual', 'recording');

  // Pull the session id we just created from diagnostics so we can stop it.
  const diag = await app.diagnostics();
  expect(diag.orchestrator.sessionId).not.toBeNull();

  await main.evaluate(async (sid: string) => {
    await window.electronAPI.recording.stopMeeting({ sessionId: sid });
  }, diag.orchestrator.sessionId!);

  // After stop, the orchestrator goes stopping → idle. With mock ASR the
  // pending chunk completes quickly; the HUD eventually settles back to
  // recording=idle (visual may transiently be 'processing'/'busy' first).
  await expect(pill).toHaveAttribute('data-hud-recording', 'idle');
});
