/**
 * Phase 6 — Recording happy paths (E1 dictation, F1 meeting, F2 detail).
 *
 * Each spec uses `launchApp` directly (not the shared `app` fixture) so it
 * can opt into `micBackend: 'mock_sine'`. The audio-process emits a 440 Hz
 * sine wave instead of silence — ChunkWriter's VAD gate then passes the
 * chunk through to MockAsrClient, which returns "(mock transcript)" and
 * populates the transcripts table.
 *
 * If we used the default silent mic, every chunk would be VAD-skipped and
 * the Dictations / Meetings UI would show no transcript text — making
 * post-stop assertions less meaningful for the happy-path scenarios.
 */

import { test, expect } from '@playwright/test';
import { launchApp } from './fixtures/app';

const HAS_SECRET = !!process.env.TWINMIND_E2E_TEST_SECRET;

test.beforeEach(({}, testInfo) => {
  test.skip(!HAS_SECRET, 'TWINMIND_E2E_TEST_SECRET not set');
});

test('E1 dictation hotkey hold/release produces a tile in Dictations', async () => {
  const app = await launchApp({ micBackend: 'mock_sine' });
  try {
    await app.completeWizard();
    await app.signIn();

    const main = await app.mainPage();

    // Drive the dictation via the same IPC the hotkey-press handler fires.
    // We can't synthesize Fn/Globe key events from Playwright, so the
    // press/release semantics are exercised through their IPC entry points.
    await main.evaluate(async () => {
      await window.electronAPI.recording.startDictation();
    });

    // Let the audio-process emit a few hundred ms of sine into the live
    // chunk. The orchestrator's stopDictation closes that chunk, encodes
    // it, and queues it for upload — MockAsrClient resolves synchronously.
    await main.waitForTimeout(800);

    await main.evaluate(async () => {
      await window.electronAPI.recording.stopDictation();
    });

    // Navigate to Dictations and wait for the new tile to appear. The list
    // refreshes via DICTATION_LIST on session events; we poll the DOM
    // rather than guess at the refresh cadence.
    await main.getByTestId('tab-dictations').click();
    await expect(main.getByTestId('dictation-tile').first()).toBeVisible({ timeout: 10_000 });
  } finally {
    await app.close();
  }
});

test('F1 meeting start/stop creates a row in the Meetings tab', async () => {
  const app = await launchApp({ micBackend: 'mock_sine' });
  try {
    await app.completeWizard();
    await app.signIn();

    const main = await app.mainPage();

    await main.evaluate(async () => {
      await window.electronAPI.recording.startMeeting();
    });
    await main.waitForTimeout(800);

    const diag = await app.diagnostics();
    expect(diag.orchestrator.sessionId).not.toBeNull();
    const sessionId = diag.orchestrator.sessionId!;

    await main.evaluate(async (sid: string) => {
      await window.electronAPI.recording.stopMeeting({ sessionId: sid });
    }, sessionId);

    // Wait for the orchestrator to settle back to idle before navigating —
    // otherwise the SessionsList might mount while the row's status is
    // still 'active', and the "active session" indicator differs from
    // 'ended'. Tolerant assertion: SessionsList filters by mode='meeting'
    // and shows the row regardless of status.
    await main.getByTestId('tab-meetings').click();
    // data-session-id lives on the row itself, not a child — use a direct
    // attribute selector rather than filter({has}) which would require a
    // matching descendant.
    const row = main.locator(
      `[data-testid="session-row"][data-session-id="${sessionId}"]`,
    );
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row).toHaveAttribute('data-session-mode', 'meeting');
  } finally {
    await app.close();
  }
});

test('F2 opening a meeting row mounts SessionDetail with the session id', async () => {
  const app = await launchApp({ micBackend: 'mock_sine' });
  try {
    await app.completeWizard();
    await app.signIn();

    const main = await app.mainPage();

    await main.evaluate(async () => {
      await window.electronAPI.recording.startMeeting();
    });
    await main.waitForTimeout(800);
    const diag = await app.diagnostics();
    const sessionId = diag.orchestrator.sessionId!;
    await main.evaluate(async (sid: string) => {
      await window.electronAPI.recording.stopMeeting({ sessionId: sid });
    }, sessionId);

    await main.getByTestId('tab-meetings').click();
    const row = main.locator(
      `[data-testid="session-row"][data-session-id="${sessionId}"]`,
    );
    await expect(row).toBeVisible({ timeout: 10_000 });

    await row.click();

    // SessionDetail mounts with data-session-id = the row we just clicked.
    const detail = main.getByTestId('session-detail');
    await expect(detail).toBeVisible();
    await expect(detail).toHaveAttribute('data-session-id', sessionId);
    // And the back button is reachable.
    await expect(main.getByTestId('session-detail-back')).toBeVisible();
  } finally {
    await app.close();
  }
});
