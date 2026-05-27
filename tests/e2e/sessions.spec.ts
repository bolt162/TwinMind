/**
 * Phase 7 — Session / transcript happy paths (G1 + G2-substitute).
 *
 * G1: clicking the row's Copy button writes the formatted transcript to
 *     the OS clipboard. We read it back via Electron's main-process
 *     `clipboard` module so we don't have to wrestle with renderer-side
 *     clipboard-read permissions.
 *
 * G2-substitute: opening SessionDetail renders the chunk transcript text
 *     (MockAsrClient returns "(mock transcript)" for every chunk). We
 *     swapped the originally-scoped "View Summary" assertion because the
 *     summary path makes a real call to the dev backend; covering the
 *     mock-summary fixture is deferred — the transcript-render assertion
 *     still exercises the chunk → ASR → DB → UI chain end-to-end.
 */

import { test, expect } from '@playwright/test';
import { launchApp } from './fixtures/app';

const HAS_SECRET = !!process.env.TWINMIND_E2E_TEST_SECRET;
const MOCK_TRANSCRIPT_TEXT = '(mock transcript)';

test.beforeEach(({}, testInfo) => {
  test.skip(!HAS_SECRET, 'TWINMIND_E2E_TEST_SECRET not set');
});

test('G1 row Copy button writes the transcript to the clipboard', async () => {
  const app = await launchApp({ micBackend: 'mock_sine' });
  try {
    await app.completeWizard();
    await app.signIn();
    const main = await app.mainPage();

    // Create a meeting with a real (mock-sine) chunk so transcript exists.
    // Hold the recording a bit longer than the other recording specs so the
    // chunk has more signal — VAD occasionally flags very-short sine slices
    // as silence when running under a cold audio-process. Defensive.
    await main.evaluate(async () => {
      await window.electronAPI.recording.startMeeting();
    });
    await main.waitForTimeout(1500);
    const diag = await app.diagnostics();
    const sessionId = diag.orchestrator.sessionId!;
    await main.evaluate(async (sid: string) => {
      await window.electronAPI.recording.stopMeeting({ sessionId: sid });
    }, sessionId);

    await main.getByTestId('tab-meetings').click();
    const row = main.locator(
      `[data-testid="session-row"][data-session-id="${sessionId}"]`,
    );
    await expect(row).toBeVisible({ timeout: 15_000 });

    // The Copy button gates on session.hasText, which only flips true once
    // the chunk has finished encoding (ffmpeg) + uploading (MockAsrClient)
    // + the transcript row landed in the DB. On a cold audio-process this
    // pipeline can take several seconds; poll generously.
    const copyButton = row.locator('[data-testid="session-row-copy-button"]');
    await expect(copyButton).toBeEnabled({ timeout: 30_000 });
    await copyButton.click();

    // Read the clipboard from the main process (avoids navigator.clipboard
    // permission prompts in the renderer).
    const clipText = await app.electronApp.evaluate(({ clipboard }) =>
      clipboard.readText(),
    );
    expect(clipText).toContain(MOCK_TRANSCRIPT_TEXT);
  } finally {
    await app.close();
  }
});

test('G2 SessionDetail renders the chunk transcript text', async () => {
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

    const detail = main.getByTestId('session-detail');
    await expect(detail).toBeVisible();

    // At least one transcript chunk renders and contains the mock text.
    const chunkText = main.getByTestId('transcript-chunk-text').first();
    await expect(chunkText).toHaveText(MOCK_TRANSCRIPT_TEXT, { timeout: 10_000 });
  } finally {
    await app.close();
  }
});
