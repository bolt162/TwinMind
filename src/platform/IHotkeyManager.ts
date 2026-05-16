/**
 * IHotkeyManager — global keyboard shortcuts.
 *
 * Architecture: §5 (composite of `electron.globalShortcut`, `uiohook-napi`,
 * `GlobeKeyManager`), §16.1 step 7 (onboarding chooses dictation hotkey).
 *
 * Two flavors of binding:
 *   - press/release: hold-to-talk (dictation hotkey). Fires on key down AND
 *     key up. Takes a structured Hotkey so we can route modifier-only and
 *     L/R-specific bindings through uiohook directly.
 *   - tap: classical accelerator string for the few internal/legacy uses
 *     that don't need press/release semantics. No call site uses it today.
 */

import type { Hotkey } from '@core/hotkey/HotkeyTypes';

export type HotkeyAccelerator = string;

export interface PressReleaseBinding {
  readonly hotkey: Hotkey;
  readonly onPress: () => void;
  readonly onRelease: () => void;
}

export interface TapBinding {
  readonly accelerator: HotkeyAccelerator;
  readonly onTap: () => void;
}

export interface IHotkeyManager {
  /** Register a press/release pair. Returns an unregister callback. */
  registerPressRelease(binding: PressReleaseBinding): () => void;

  /** Register a single-tap accelerator. Returns an unregister callback. */
  registerTap(binding: TapBinding): () => void;

  /** Unregister everything; called at app quit. */
  unregisterAll(): void;
}
