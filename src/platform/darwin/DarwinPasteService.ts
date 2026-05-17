/**
 * DarwinPasteService — paste dictated text into the active app.
 *
 * Architecture: §5 (PasteService), §7.4 (dictation completes with a paste),
 * §12.5 (Accessibility permission required for cross-app keyboard input).
 *
 * Strategy:
 *   1. Write the text to the system pasteboard via Electron's clipboard.
 *   2. If Accessibility is granted, invoke `osascript` to send Cmd-V to the
 *      frontmost app. This carries V1's working approach and avoids a native
 *      AXUIElement addon for MVP.
 *   3. If Accessibility is NOT granted, return `clipboardOnly: true` so the
 *      UI can show a "press Cmd-V" hint.
 *
 * The osascript path takes ~150 ms end-to-end. A future native impl using
 * AXUIElement can drop that to ~20 ms but isn't worth the complexity for
 * a per-recording one-shot.
 */

import { spawn } from 'node:child_process';
import { clipboard, systemPreferences } from 'electron';
import type { IPasteService, PasteResult } from '../IPasteService';

/**
 * AppleScript that tells the frontmost app to issue Cmd-V. We use `delay 0.05`
 * so the keypress hits *after* the clipboard write has propagated.
 */
const PASTE_SCRIPT = `
delay 0.05
tell application "System Events" to keystroke "v" using {command down}
`;

export class DarwinPasteService implements IPasteService {
  /** Paste `text` into the active app, falling back to clipboard-only. */
  async paste(text: string): Promise<PasteResult> {
    clipboard.writeText(text);

    if (!systemPreferences.isTrustedAccessibilityClient(false)) {
      return { pasted: false, clipboardOnly: true };
    }

    try {
      await this.runOsascript();
      return { pasted: true, clipboardOnly: false };
    } catch (err) {
      // Surface as clipboard-only; the user can manually Cmd-V.
      return {
        pasted: false,
        clipboardOnly: true,
        ...(err instanceof Error ? { target: err.message } : {}),
      };
    }
  }

  /** Spawn `osascript -e <PASTE_SCRIPT>` and resolve on exit 0. */
  private runOsascript(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/osascript', ['-e', PASTE_SCRIPT], {
        stdio: 'ignore',
      });
      child.on('exit', (code) => {
        code === 0 ? resolve() : reject(new Error(`osascript exited ${code}`));
      });
      child.on('error', reject);
    });
  }
}
