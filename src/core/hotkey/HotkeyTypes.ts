/**
 * HotkeyTypes — shared structured hotkey shape.
 *
 * Replaces the legacy Electron accelerator string ("Cmd+Shift+D") with a
 * format that supports:
 *   - Left/Right modifier distinction (ShiftLeft vs ShiftRight) — Wispr-style
 *   - Modifier-only bindings (Right Option, Fn, Cmd+Shift, …)
 *   - Modifier + key (Cmd+Shift+D, ⌘+Space, …)
 *
 * Modifier codes follow the `KeyboardEvent.code` convention so the renderer
 * can capture them directly without translation:
 *   ShiftLeft, ShiftRight, ControlLeft, ControlRight, AltLeft, AltRight,
 *   MetaLeft, MetaRight, Fn (synthetic — KeyboardEvent doesn't expose Fn
 *   on macOS; we surface it via the existing GlobeKeyManager path).
 *
 * Key codes also follow `KeyboardEvent.code`: 'KeyA'..'KeyZ', 'Digit0'..,
 * 'Space', 'Enter', 'Escape', 'F1'..'F24'. The `display` field carries the
 * human-friendly rendering ('A', '5', 'Space', '⏎') so neither the matcher
 * nor the chip renderer needs to know about KeyboardEvent.code internals.
 */

export type HotkeyModifier =
  | 'MetaLeft'
  | 'MetaRight'
  | 'ControlLeft'
  | 'ControlRight'
  | 'AltLeft'
  | 'AltRight'
  | 'ShiftLeft'
  | 'ShiftRight'
  | 'Fn';

export interface HotkeyKey {
  /** KeyboardEvent.code, e.g., 'KeyD', 'Digit5', 'Space'. */
  readonly code: string;
  /** Display string for chips/labels, e.g., 'D', '5', 'Space'. */
  readonly display: string;
}

export interface Hotkey {
  /**
   * Active modifiers. Order is canonicalized via `sortModifiers` so equality
   * checks are stable. A binding must have either at least one modifier OR
   * be modifier-only (modifiers + key=null) — a bare letter would hijack
   * normal typing and is rejected by the capture UI.
   */
  readonly modifiers: ReadonlyArray<HotkeyModifier>;
  /** null = modifier-only binding (e.g., hold Right Option). */
  readonly key: HotkeyKey | null;
}

/** Canonical sort order so two captures of the same combo compare equal. */
const MODIFIER_ORDER: Record<HotkeyModifier, number> = {
  Fn: 0,
  MetaLeft: 1,
  MetaRight: 2,
  ControlLeft: 3,
  ControlRight: 4,
  AltLeft: 5,
  AltRight: 6,
  ShiftLeft: 7,
  ShiftRight: 8,
};

export function sortModifiers(
  mods: ReadonlyArray<HotkeyModifier>,
): ReadonlyArray<HotkeyModifier> {
  return [...mods].sort((a, b) => MODIFIER_ORDER[a] - MODIFIER_ORDER[b]);
}

/** True iff two hotkeys describe the same binding. */
export function hotkeysEqual(a: Hotkey | null, b: Hotkey | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.modifiers.length !== b.modifiers.length) return false;
  for (let i = 0; i < a.modifiers.length; i++) {
    if (a.modifiers[i] !== b.modifiers[i]) return false;
  }
  if (a.key === null || b.key === null) return a.key === b.key;
  return a.key.code === b.key.code;
}

/**
 * Render a hotkey as a chip-friendly string, e.g., 'Left ⌘ + Right ⇧ + D'
 * or 'Right ⌥' or 'Fn'. The L/R side is spelled out (rather than a small
 * superscript) so users don't have to squint at the chip to tell which
 * side they picked. Parts are joined with ' + '.
 */
export function formatHotkey(h: Hotkey): string {
  const parts: string[] = [];
  for (const m of h.modifiers) {
    parts.push(formatModifier(m));
  }
  if (h.key) parts.push(h.key.display);
  return parts.join(' + ');
}

function formatModifier(m: HotkeyModifier): string {
  switch (m) {
    case 'Fn':
      return 'Fn';
    case 'MetaLeft':
      return 'Left ⌘';
    case 'MetaRight':
      return 'Right ⌘';
    case 'ControlLeft':
      return 'Left ⌃';
    case 'ControlRight':
      return 'Right ⌃';
    case 'AltLeft':
      return 'Left ⌥';
    case 'AltRight':
      return 'Right ⌥';
    case 'ShiftLeft':
      return 'Left ⇧';
    case 'ShiftRight':
      return 'Right ⇧';
  }
}

/** True iff `code` is a modifier (KeyboardEvent.code convention). */
export function isModifierCode(code: string): code is HotkeyModifier {
  return (
    code === 'MetaLeft' ||
    code === 'MetaRight' ||
    code === 'ControlLeft' ||
    code === 'ControlRight' ||
    code === 'AltLeft' ||
    code === 'AltRight' ||
    code === 'ShiftLeft' ||
    code === 'ShiftRight' ||
    code === 'Fn'
  );
}
