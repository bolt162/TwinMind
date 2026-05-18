/**
 * DarwinPasteService — paste dictated text into the active app.
 *
 * Architecture: §5 (PasteService), §7.4 (dictation completes with a paste),
 * §12.5 (Accessibility permission required for cross-app keyboard input).
 *
 * Strategy:
 *   1. Write the text to the system pasteboard via Electron's clipboard.
 *   2. If Accessibility is granted, synthesize Cmd-V at the HID event tap
 *      via the native `pasteCommandV()` export of `@twinmind/coreaudio-darwin`.
 *      That export wraps CGEventPost, which only needs Accessibility — the
 *      same grant the user already gave for the Globe-key tap.
 *   3. If Accessibility is NOT granted, return `clipboardOnly: true` so the
 *      UI can show a "press Cmd-V" hint.
 *
 * Why not osascript: the previous implementation ran `osascript -e 'tell
 * application "System Events" to keystroke …'`. Driving System Events via
 * AppleScript counts as Apple Events / Automation, a *separate* TCC bucket
 * from Accessibility, which surfaces a second "TwinMind wants to control
 * System Events" dialog the first time the user dictates. CGEventPost piggy-
 * backs on the Accessibility grant we already require, so no second dialog.
 */

import { clipboard, systemPreferences } from 'electron';
import type { IPasteService, PasteResult } from '../IPasteService';

interface NativePasteModule {
  pasteCommandV?: () => boolean;
}

export class DarwinPasteService implements IPasteService {
  /** Paste `text` into the active app, falling back to clipboard-only. */
  async paste(text: string): Promise<PasteResult> {
    clipboard.writeText(text);

    if (!systemPreferences.isTrustedAccessibilityClient(false)) {
      return { pasted: false, clipboardOnly: true };
    }

    // Small delay so the clipboard write has propagated through the
    // pasteboard server before the Cmd-V keystroke fires. 50 ms matches what
    // the prior osascript path used.
    await sleep(50);

    try {
      const native = loadNative();
      if (!native?.pasteCommandV) {
        return { pasted: false, clipboardOnly: true, target: 'native addon missing' };
      }
      const ok = native.pasteCommandV();
      return ok
        ? { pasted: true, clipboardOnly: false }
        : { pasted: false, clipboardOnly: true };
    } catch (err) {
      return {
        pasted: false,
        clipboardOnly: true,
        ...(err instanceof Error ? { target: err.message } : {}),
      };
    }
  }
}

let cachedNative: NativePasteModule | null | undefined;

/**
 * Lazy-load the native addon. Cached after first attempt — missing addons
 * (dev environment, ABI mismatch) should not be retried on every paste.
 */
function loadNative(): NativePasteModule | null {
  if (cachedNative !== undefined) return cachedNative;
  try {
    cachedNative = require('@twinmind/coreaudio-darwin') as NativePasteModule;
  } catch {
    cachedNative = null;
  }
  return cachedNative;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
