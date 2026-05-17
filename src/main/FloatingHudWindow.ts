/**
 * FloatingHudWindow — the always-on-top mic-button overlay (Wispr Flow style).
 *
 * Architecture: §4 (renderer is a thin view), §16.2 (settings — "show in menu
 * bar" toggle interacts with this).
 *
 * Behavior:
 *  - Small, frameless, transparent, sandboxed window with a single React
 *    component (HUD entry in `src/renderer/hud/`).
 *  - **Visible on every macOS Space**, including fullscreen apps
 *    (`setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`).
 *  - **Follows the cursor's display on multi-monitor setups**: placed on the
 *    display currently under the cursor at construction time, and re-placed
 *    when the display configuration changes or when `revealOnActiveDisplay()`
 *    is called from main (e.g., on hotkey trigger).
 *  - macOS `type: 'panel'` makes the window non-activating — clicking it
 *    triggers the React handler without stealing focus from the user's
 *    active app, which matters for dictation-into-other-apps.
 */

import path from 'node:path';
import { BrowserWindow, screen, type WebContents } from 'electron';

// Window is sized for the *failed* pill width plus the right-side Home
// button (~32px + gap) — wider and taller than the recording/idle states —
// so CSS transitions inside the renderer can grow the pill into the error
// banner without resizing the BrowserWindow.
const HUD_WIDTH = 420;
const HUD_HEIGHT = 80;
const DISPLAY_MARGIN = 24;

export class FloatingHudWindow {
  private readonly win: BrowserWindow;

  /** Construct, position on the cursor's display, and load the HUD HTML.
   *  Set `initiallyVisible=false` to keep the window hidden after load — main
   *  reveals it later (used to suppress the HUD during onboarding). */
  constructor(preloadPath: string, htmlPath: string, devUrl?: string, initiallyVisible = true) {
    this.win = new BrowserWindow({
      width: HUD_WIDTH,
      height: HUD_HEIGHT,
      // Hide chrome — we render our own pill button in React.
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      // macOS panel: non-activating window that doesn't steal focus on click.
      // Falls back gracefully on other platforms.
      ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      // Don't show until the renderer has laid out, to avoid a flash.
      show: false,
      // Don't move the OS focus when the user clicks the button.
      focusable: false,
      // Allow click-through behavior to be set by the renderer later if needed.
      acceptFirstMouse: true,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });

    // Show across all macOS Spaces — including fullscreen apps the user
    // is dictating into. The second arg matters; without it, the HUD
    // disappears when any other app goes fullscreen.
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // `floating` keeps us above normal windows but below the screensaver
    // and notifications, which is the right place for a control HUD.
    this.win.setAlwaysOnTop(true, 'floating');

    // Default to "click-through everywhere except where the renderer says
    // otherwise". The HUD window is sized for the widest pill state (failed
    // banner ~340px) but the visible content is much smaller most of the
    // time — the 250-380px of transparent surround used to capture clicks,
    // blocking apps behind the HUD and triggering macOS panel-activation
    // (which raised the main window). With forward:true, mouseenter on the
    // pill/Home-button still fires and the renderer toggles ignore back
    // off so clicks land where the user actually intends.
    this.win.setIgnoreMouseEvents(true, { forward: true });

    // Load the HUD HTML. Dev mode points at the vite dev server with a hash
    // route so the same vite process can serve main + hud.
    if (devUrl) {
      void this.win.loadURL(devUrl);
    } else {
      void this.win.loadFile(htmlPath);
    }

    this.placeOnActiveDisplay();
    if (initiallyVisible) {
      this.win.once('ready-to-show', () => this.win.show());
    }

    // Reposition (only if currently off-screen) on display configuration
    // changes — handles monitor disconnect, resolution change, dock-resize.
    screen.on('display-metrics-changed', () => this.ensureOnScreen());
    screen.on('display-added', () => this.ensureOnScreen());
    screen.on('display-removed', () => this.ensureOnScreen());
  }

  /** Renderer webContents for IpcBridgeMain.broadcast. */
  webContents(): WebContents {
    return this.win.webContents;
  }

  /**
   * Show the HUD, raising it on the active display only when it's lost —
   * hidden, off-screen, or on a now-disconnected display. If the user has
   * manually dragged the HUD to a spot they like, we keep it there on
   * every subsequent reveal.
   */
  revealOnActiveDisplay(): void {
    if (!this.win.isVisible() || !this.isOnAnyDisplay()) {
      this.placeOnActiveDisplay();
    }
    if (!this.win.isVisible()) this.win.show();
  }

  /** True iff the HUD's current bounds intersect at least one display. */
  private isOnAnyDisplay(): boolean {
    const bounds = this.win.getBounds();
    return screen.getAllDisplays().some((d) => intersects(d.workArea, bounds));
  }

  hide(): void {
    this.win.hide();
  }

  // ─── Manual drag (called by the HUD renderer) ──────────────────────────
  // We could enable native drag with `-webkit-app-region: drag` on the
  // pill, but that intercepts all click events — drag and click on the
  // same element is incompatible. Instead the renderer tracks mousedown
  // → mousemove → mouseup in JS and asks main to move the window. We
  // snapshot the bounds at beginDrag so the renderer can pass simple
  // deltas instead of having to know absolute coordinates.
  private dragSnapshot: { x: number; y: number } | null = null;

  beginDrag(): void {
    const b = this.win.getBounds();
    this.dragSnapshot = { x: b.x, y: b.y };
  }

  dragMoveBy(dx: number, dy: number): void {
    if (!this.dragSnapshot) return;
    this.win.setPosition(
      Math.round(this.dragSnapshot.x + dx),
      Math.round(this.dragSnapshot.y + dy),
    );
  }

  endDrag(): void {
    this.dragSnapshot = null;
  }

  /**
   * Renderer-driven click-through toggle. The HUD window starts with
   * ignore=true (all clicks pass through); the renderer flips it to false
   * on mouseenter of the pill/Home button and back to true on mouseleave.
   * `forward:true` keeps mousemove events flowing so the renderer can
   * actually detect those enter/leave transitions even while ignoring.
   */
  setMouseIgnore(ignore: boolean): void {
    if (this.win.isDestroyed()) return;
    this.win.setIgnoreMouseEvents(ignore, { forward: ignore });
  }

  /** Used by main.ts on app quit. */
  destroy(): void {
    if (!this.win.isDestroyed()) this.win.destroy();
  }

  /** Move to the bottom-center of whichever display has the cursor right now. */
  private placeOnActiveDisplay(): void {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const { x, y, width, height } = display.workArea;
    this.win.setBounds({
      x: x + Math.round((width - HUD_WIDTH) / 2),
      y: y + height - HUD_HEIGHT - DISPLAY_MARGIN,
      width: HUD_WIDTH,
      height: HUD_HEIGHT,
    });
  }

  /**
   * If the HUD's current position is no longer on any connected display
   * (monitor disconnected), recenter on the active display. Otherwise leave
   * it where the user (or last reveal) put it.
   */
  private ensureOnScreen(): void {
    const bounds = this.win.getBounds();
    const displays = screen.getAllDisplays();
    const stillOnScreen = displays.some((d) => intersects(d.workArea, bounds));
    if (!stillOnScreen) this.placeOnActiveDisplay();
  }
}

/** True iff `a` and `b` share at least one pixel. */
function intersects(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}
