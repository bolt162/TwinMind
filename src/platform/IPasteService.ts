/**
 * IPasteService — paste a string into the active app.
 *
 * Architecture: §5 (PasteService), §7.4 (dictation pastes transcript on stop),
 * §12.5 (Accessibility permission required for cmd-V into other apps).
 *
 * Implementations:
 *   - macOS: AXUIElement send-keys + NSPasteboard.
 *   - macOS fallback (no Accessibility grant): copy to clipboard, surface
 *     "Press Cmd-V to paste" toast (carries V1's behavior).
 *   - Windows: SendInput + clipboard.
 */

export interface PasteResult {
  /** True if the text reached the active app's text field. */
  readonly pasted: boolean;
  /**
   * True if we fell back to clipboard-only (Accessibility denied or active
   * app not pasteable). The renderer should surface a "press Cmd-V" hint.
   */
  readonly clipboardOnly: boolean;
  /** Bundle id / window title of the target app at paste time, if known. */
  readonly target?: string;
}

export interface IPasteService {
  /** Paste `text` into the focused app; returns what actually happened. */
  paste(text: string): Promise<PasteResult>;
}
