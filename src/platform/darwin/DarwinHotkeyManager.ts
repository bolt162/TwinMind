/**
 * DarwinHotkeyManager — global keyboard shortcuts (macOS).
 *
 * Architecture: §5 (composite of globalShortcut + uiohook-napi + Globe).
 *
 * All `registerPressRelease` bindings now run through `uiohook-napi`. We
 * dropped `globalShortcut` for the user-configurable hotkey because:
 *   - `globalShortcut` can't observe modifier-only bindings (e.g., "Right
 *     Option" alone).
 *   - It collapses left/right modifier presses into a single accelerator,
 *     losing the L/R distinction the new structured `Hotkey` format
 *     captures via `KeyboardEvent.code`.
 *   - It only fires once per accelerator activation — we need press AND
 *     release for hold-to-dictate.
 *
 * The Fn (Globe) key is still handled by the separate `DarwinGlobeKeyManager`
 * — uiohook doesn't see Fn on macOS.
 */

import { globalShortcut, systemPreferences } from 'electron';
import type {
  IHotkeyManager,
  PressReleaseBinding,
  TapBinding,
} from '../IHotkeyManager';
import type { Hotkey, HotkeyModifier } from '@core/hotkey/HotkeyTypes';
import { type Logger, noopLogger } from '@core/observability/Logger';

interface UiohookLike {
  start(): void;
  stop(): void;
  on(event: 'keydown' | 'keyup', cb: (e: UiohookEvent) => void): void;
}
interface UiohookModule {
  uIOhook: UiohookLike;
  UiohookKey: Record<string, number>;
}

interface UiohookEvent {
  readonly keycode: number;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/** Loaded lazily with uiohook; resolves an accelerator key name → keycode. */
let UiohookKey: Record<string, number> | null = null;

/**
 * KeyboardEvent.code (renderer-captured) → uiohook key-table name.
 * Keep this minimal — anything we don't map can't be configured today.
 */
function uiohookNameForModifier(m: HotkeyModifier): string | null {
  switch (m) {
    case 'MetaLeft':
      return 'Meta';
    case 'MetaRight':
      return 'MetaRight';
    case 'ControlLeft':
      return 'Ctrl';
    case 'ControlRight':
      return 'CtrlRight';
    case 'AltLeft':
      return 'Alt';
    case 'AltRight':
      return 'AltRight';
    case 'ShiftLeft':
      return 'Shift';
    case 'ShiftRight':
      return 'ShiftRight';
    case 'Fn':
      // Fn is invisible to uiohook on macOS — bindings that include Fn must
      // be routed through DarwinGlobeKeyManager instead. The matcher returns
      // null so the caller logs + skips registration.
      return null;
  }
}

function uiohookNameForKeyCode(code: string): string | null {
  // 'KeyA'..'KeyZ' → 'A'..'Z'
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  // 'Digit0'..'Digit9' → '0'..'9'
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  // Function keys + named keys passthrough where the table already names them.
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (code === 'Space' || code === 'Enter' || code === 'Escape') return code;
  return null;
}

export class DarwinHotkeyManager implements IHotkeyManager {
  private uio: UiohookLike | null = null;
  /** Whether the libuiohook native module is loaded + keydown/keyup listeners
   *  are wired. Separate from `uioStarted` (which gates the CGEventTap). We
   *  load eagerly on the first registerPressRelease so `UiohookKey` is
   *  populated and bindings can be stored — even when Accessibility is
   *  denied and the tap can't start yet. Loading the module does NOT
   *  install a CGEventTap; that only happens on `uio.start()`. */
  private uioModuleLoaded = false;
  private uioStarted = false;

  /** Active tap bindings (legacy globalShortcut path). */
  private readonly taps = new Set<string>();

  /**
   * Press/release bindings (uiohook-driven). Each entry carries the *target
   * set* of uiohook keycodes the binding requires to be exactly held, so the
   * dispatcher can detect transitions in/out of the matched state.
   */
  private readonly pressReleases = new Map<
    symbol,
    {
      readonly target: ReadonlySet<number>;
      readonly onPress: () => void;
      readonly onRelease: () => void;
      // Whether the binding is currently in the "pressed" state. Set by the
      // dispatcher on the leading edge; cleared on the trailing edge.
      pressed: boolean;
    }
  >();

  /** Currently-held keycodes across all keyboards. Updated by the dispatcher. */
  private readonly heldKeycodes = new Set<number>();

  constructor(private readonly logger: Logger = noopLogger) {}

  /** Register a single-tap accelerator via Electron globalShortcut. */
  registerTap(binding: TapBinding): () => void {
    const ok = globalShortcut.register(binding.accelerator, binding.onTap);
    if (!ok) {
      this.logger.warn('hotkey conflict', { accelerator: binding.accelerator });
      return () => {};
    }
    this.taps.add(binding.accelerator);
    return () => {
      globalShortcut.unregister(binding.accelerator);
      this.taps.delete(binding.accelerator);
    };
  }

  /** Register a press/release pair via uiohook-napi. */
  registerPressRelease(binding: PressReleaseBinding): () => void {
    // Load the JS module first (populates UiohookKey + attaches listeners)
    // so compileHotkeyToKeycodes can resolve the keycodes even when
    // Accessibility is denied and the tap can't start yet. Without this
    // ordering the binding would be discarded and a later restartUio()
    // after re-grant would have nothing to install.
    this.loadUioModule();
    const target = compileHotkeyToKeycodes(binding.hotkey);
    if (!target) {
      this.logger.warn('could not compile hotkey; press/release ignored', {
        hotkey: binding.hotkey,
      });
      return () => {};
    }
    // Now that the binding is compiled, try to start the tap. If Accessibility
    // is denied this is a no-op; the accessibility watcher will call
    // restartUio() once trust is regained.
    this.startUioTap();
    const id = Symbol('press_release_binding');
    this.pressReleases.set(id, {
      target,
      onPress: binding.onPress,
      onRelease: binding.onRelease,
      pressed: false,
    });
    return () => {
      const entry = this.pressReleases.get(id);
      // If the binding is removed mid-press, fire release so callers don't
      // get stuck in a "hold" state forever.
      if (entry?.pressed) {
        try {
          entry.onRelease();
        } catch {
          /* user callback; not our problem */
        }
      }
      this.pressReleases.delete(id);
    };
  }

  /**
   * Stop uiohook WITHOUT clearing any registered press/release bindings,
   * fire synthetic releases for anything currently pressed, and zero out
   * `heldKeycodes` so a fresh start() doesn't believe a phantom key is
   * still down.
   *
   * Used by the accessibility watcher: when macOS revokes Accessibility we
   * stop uiohook proactively so libuiohook isn't running an event tap
   * under a now-untrusted process — and we keep `pressReleases` intact so
   * the SAME bindings come back online when trust is regained.
   *
   * Idempotent.
   */
  stopUio(): void {
    for (const entry of this.pressReleases.values()) {
      if (entry.pressed) {
        entry.pressed = false;
        try {
          entry.onRelease();
        } catch {
          /* user callback */
        }
      }
    }
    this.heldKeycodes.clear();
    if (this.uio && this.uioStarted) {
      try {
        this.uio.stop();
      } catch {
        /* best-effort */
      }
      this.uioStarted = false;
    }
  }

  /**
   * Re-arm uiohook after a prior stopUio(). No-op if uiohook is already
   * running or no press/release bindings exist (deferred-start path —
   * startUioTap is invoked on the next registerPressRelease).
   */
  restartUio(): void {
    if (this.uioStarted) return;
    if (this.pressReleases.size === 0) return;
    this.startUioTap();
  }

  /** Tear down all bindings; called from app `before-quit`. */
  unregisterAll(): void {
    for (const acc of this.taps) globalShortcut.unregister(acc);
    this.taps.clear();
    for (const entry of this.pressReleases.values()) {
      if (entry.pressed) {
        try {
          entry.onRelease();
        } catch {
          /* swallow */
        }
      }
    }
    this.pressReleases.clear();
    this.heldKeycodes.clear();
    if (this.uio && this.uioStarted) {
      try {
        this.uio.stop();
      } catch {
        /* best-effort */
      }
      this.uioStarted = false;
    }
  }

  /**
   * Load the libuiohook native module + wire dispatch listeners, but do NOT
   * start the CGEventTap. Idempotent — runs once, regardless of how many
   * times registerPressRelease is called. Loading alone does not install
   * any OS-level hook (that's `uio.start()`), so it's safe even when
   * Accessibility is denied.
   *
   * This exists so `UiohookKey` is populated and `compileHotkeyToKeycodes`
   * can succeed BEFORE the tap is actually startable. Bindings then land
   * in `pressReleases` and survive the deferred-start path.
   */
  private loadUioModule(): void {
    if (this.uioModuleLoaded) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('uiohook-napi') as UiohookModule;
      this.uio = mod.uIOhook;
      UiohookKey = mod.UiohookKey;
      this.uio.on('keydown', (e) => this.dispatch(e, 'down'));
      this.uio.on('keyup', (e) => this.dispatch(e, 'up'));
      this.uioModuleLoaded = true;
    } catch (err) {
      this.logger.error('uiohook-napi unavailable', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Start the libuiohook CGEventTap. Gated on Accessibility trust — libuiohook
   * installs at kCGHeadInsertEventTap, which can wedge under an untrusted
   * process. Bindings stay queued in `pressReleases`; the accessibility
   * watcher calls `restartUio()` once trust is regained.
   */
  private startUioTap(): void {
    if (this.uioStarted) return;
    if (!this.uioModuleLoaded || !this.uio) return;
    if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) {
      this.logger.warn('uiohook start deferred: Accessibility not granted');
      return;
    }
    try {
      this.uio.start();
      this.uioStarted = true;
    } catch (err) {
      this.logger.error('uiohook start failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Dispatcher: maintain `heldKeycodes` and check every binding for a
   * leading/trailing edge against its target set.
   *
   *   pressed transition: keycode just added && held === target → fire onPress.
   *   release  transition: keycode just removed && was matching → fire onRelease.
   *
   * "Matching" requires exact set equality, not subset — so "Cmd+Shift" doesn't
   * accidentally fire while the user is typing "Cmd+Shift+A" in another app.
   */
  private dispatch(e: UiohookEvent, kind: 'down' | 'up'): void {
    if (kind === 'down') {
      this.heldKeycodes.add(e.keycode);
    } else {
      this.heldKeycodes.delete(e.keycode);
    }
    for (const entry of this.pressReleases.values()) {
      const matching = setsEqual(this.heldKeycodes, entry.target);
      if (matching && !entry.pressed) {
        entry.pressed = true;
        try {
          entry.onPress();
        } catch {
          /* user callback */
        }
      } else if (!matching && entry.pressed) {
        entry.pressed = false;
        try {
          entry.onRelease();
        } catch {
          /* user callback */
        }
      }
    }
  }
}

/**
 * Compile a structured Hotkey into the uiohook keycode set the dispatcher
 * matches against. Returns null if any modifier/key can't be resolved (e.g.,
 * Fn is in the binding — that's a globe-manager concern, not uiohook).
 */
function compileHotkeyToKeycodes(h: Hotkey): ReadonlySet<number> | null {
  if (!UiohookKey) return null;
  const out = new Set<number>();
  for (const m of h.modifiers) {
    const name = uiohookNameForModifier(m);
    if (!name) return null;
    const code = UiohookKey[name];
    if (typeof code !== 'number') return null;
    out.add(code);
  }
  if (h.key) {
    const name = uiohookNameForKeyCode(h.key.code);
    if (!name) return null;
    const code = UiohookKey[name];
    if (typeof code !== 'number') return null;
    out.add(code);
  }
  if (out.size === 0) return null;
  return out;
}

function setsEqual(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
