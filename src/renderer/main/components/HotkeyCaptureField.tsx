/**
 * HotkeyCaptureField — click-to-record hotkey picker (Wispr-style).
 *
 * Replaces the legacy free-text accelerator input. States:
 *   idle       → shows current binding as a pill + "Click to change".
 *   listening  → listens to window keydown/keyup, captures the next combo.
 *
 * Capture rules:
 *   - Press a non-modifier with modifiers held → commit as `mods + key`.
 *   - Press only modifiers and release them all → commit as modifier-only.
 *   - Escape (when nothing held) cancels.
 *   - A bare letter (no modifiers) is rejected — would hijack typing.
 *
 * L/R distinction comes from `KeyboardEvent.code` (ShiftLeft vs ShiftRight).
 * The captured `Hotkey` is the same shape main.ts persists and matches
 * against — no translation layer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  formatHotkey,
  isModifierCode,
  sortModifiers,
  type Hotkey,
  type HotkeyModifier,
} from '@core/hotkey/HotkeyTypes';

interface Props {
  readonly value: Hotkey | null;
  readonly onChange: (next: Hotkey | null) => void;
}

export function HotkeyCaptureField({ value, onChange }: Props) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // peakHeld grows on every keydown and is read at commit time. held shrinks
  // on keyup; we use held.size===0 as the "all modifiers released" trigger
  // for modifier-only capture.
  const heldRef = useRef<Set<string>>(new Set());
  const peakHeldRef = useRef<Set<HotkeyModifier>>(new Set());

  const beginListening = useCallback(() => {
    heldRef.current = new Set();
    peakHeldRef.current = new Set();
    setError(null);
    setListening(true);
    // Tell main to forward Fn (Globe) transitions to us. macOS doesn't
    // expose Fn through KeyboardEvent; this push is the only way to capture
    // it in the picker. End() in the cleanup branches below.
    void window.electronAPI.hotkey.captureBegin().catch(() => {});
  }, []);

  const cancel = useCallback(() => {
    heldRef.current.clear();
    peakHeldRef.current.clear();
    setListening(false);
    void window.electronAPI.hotkey.captureEnd().catch(() => {});
  }, []);

  const commit = useCallback(
    (h: Hotkey) => {
      // Fn is special: macOS only surfaces it via the OS-level Globe path
      // (not uiohook), so the matcher can't combine Fn with anything else.
      // Reject Fn+anything captures so we never persist a silently-broken
      // binding. The user retries; refs are cleared so the next press starts
      // fresh.
      const hasFn = h.modifiers.includes('Fn');
      const fnAlone = hasFn && h.modifiers.length === 1 && h.key === null;
      if (hasFn && !fnAlone) {
        heldRef.current.clear();
        peakHeldRef.current.clear();
        setError('Fn (Globe) can only be used alone. Press Fn by itself, or pick a different modifier.');
        return;
      }
      heldRef.current.clear();
      peakHeldRef.current.clear();
      setListening(false);
      setError(null);
      void window.electronAPI.hotkey.captureEnd().catch(() => {});
      onChange(h);
    },
    [onChange],
  );

  useEffect(() => {
    if (!listening) return;
    // Fn (Globe) is invisible to KeyboardEvent on macOS — main forwards it
    // as a synthetic event. We feed it through exactly the same held/peak
    // tracking as a real keydown/keyup so all the commit logic below stays
    // uniform regardless of whether the user pressed Fn or anything else.
    const unsubFn = window.electronAPI.on.hotkeyCaptureKey((e) => {
      if (e.kind === 'down') {
        heldRef.current.add(e.code);
        peakHeldRef.current.add(e.code as HotkeyModifier);
      } else {
        heldRef.current.delete(e.code);
        if (heldRef.current.size === 0 && peakHeldRef.current.size > 0) {
          commit({
            modifiers: sortModifiers([...peakHeldRef.current]),
            key: null,
          });
        }
      }
    });
    const onKeyDown = (e: KeyboardEvent) => {
      // Always consume — we don't want stray triggers in the page underneath.
      e.preventDefault();
      e.stopPropagation();
      // While Fn is held, IGNORE an incoming Escape. The native Globe tap
      // synthesizes an Esc on every Fn release (to dismiss the emoji panel),
      // and that synthetic Esc can race ahead of the forwarded Fn-up. If we
      // folded it in we'd commit a bogus "Fn+Escape", which commit() rejects
      // WITHOUT ending the capture — stranding `hotkeyCaptureWebContents` and
      // breaking Fn dictation. Dropping it lets the subsequent Fn-up commit Fn
      // cleanly. (Escape alongside a real modifier, e.g. ⌘+Escape, still works.)
      if (e.code === 'Escape' && heldRef.current.has('Fn')) {
        return;
      }
      if (e.code === 'Escape' && heldRef.current.size === 0) {
        cancel();
        return;
      }
      heldRef.current.add(e.code);
      if (isModifierCode(e.code)) {
        peakHeldRef.current.add(e.code);
        return;
      }
      // Non-modifier: that's the trigger. Must have at least one modifier,
      // otherwise we'd capture bare typing.
      if (peakHeldRef.current.size === 0) {
        setError(`"${displayForCode(e.code)}" needs a modifier (⌘/⌥/⌃/⇧).`);
        // Stay in listening; user can try again.
        heldRef.current.clear();
        peakHeldRef.current.clear();
        return;
      }
      commit({
        modifiers: sortModifiers([...peakHeldRef.current]),
        key: { code: e.code, display: displayForCode(e.code) },
      });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      heldRef.current.delete(e.code);
      if (heldRef.current.size > 0) return;
      // All keys released. If at least one modifier was held during this
      // session, commit as modifier-only.
      if (peakHeldRef.current.size > 0) {
        commit({
          modifiers: sortModifiers([...peakHeldRef.current]),
          key: null,
        });
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      unsubFn();
    };
  }, [listening, cancel, commit]);

  // Safety net: if the field unmounts (e.g. the user navigates away from
  // Settings) while a capture is in flight, main would otherwise keep its
  // `hotkeyCaptureWebContents` pointed at this dead view and forward every
  // real Fn press to it instead of starting dictation. Always end the capture
  // on unmount — main's HOTKEY_CAPTURE_END only clears when the sender matches,
  // so this is a no-op when we never began.
  useEffect(() => {
    return () => {
      void window.electronAPI.hotkey.captureEnd().catch(() => {});
    };
  }, []);

  // null and Fn-only both surface as "Fn" — they're functionally identical
  // (Globe handles both). The picker uses Fn-only to express user intent.
  const displayValue = useMemo(
    () => (value ? formatHotkey(value) : 'Fn'),
    [value],
  );

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        {!listening ? (
          <>
            <button
              type="button"
              onClick={beginListening}
              className="flex h-12 min-w-64 items-center justify-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-5 text-base hover:border-zinc-500 hover:bg-zinc-800/80"
            >
              <span className="font-mono text-base tracking-wide text-zinc-100">
                {displayValue}
              </span>
            </button>
          </>
        ) : (
          <div className="flex h-12 min-w-64 items-center justify-center gap-2 rounded-md border border-emerald-700/60 bg-emerald-900/20 px-5 text-base text-emerald-200">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
            Press your hotkey…
            <button
              type="button"
              onClick={cancel}
              className="ml-2 text-xs text-emerald-300/80 hover:text-emerald-100"
            >
              (Esc)
            </button>
          </div>
        )}
      </div>
      {error && <p className="text-xs text-amber-400">{error}</p>}
    </div>
  );
}

/** Best-effort `KeyboardEvent.code` → user-facing label. */
function displayForCode(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (code === 'Space') return 'Space';
  if (code === 'Enter') return '⏎';
  if (code === 'Escape') return 'Esc';
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return code;
}
