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
import type { HudEdgeAnchor, HudPillVisual } from '@ipc/channels';

// Window is sized for the *failed* pill width plus the right-side Home
// button (~32px + gap) — wider and taller than the recording/idle states —
// so CSS transitions inside the renderer can grow the pill into the error
// banner without resizing the BrowserWindow.
const HUD_WIDTH = 480;
const HUD_HEIGHT = 124;
const DISPLAY_MARGIN = 24;

// ─── Pill geometry inside the 480 × 124 transparent window ──────────────────
// The idle pill is the LEFTMOST item in a flex group (pill + Take notes +
// Home buttons + 2 gaps = 116 px) that's centered horizontally. So the
// pill sits 182–226 px from the window's left edge in idle. Drag clamping
// keeps THIS 44 × 22 rectangle inside the cursor-nearest display's
// workArea — the surrounding transparent surround is allowed to extend
// past the workArea edges.
const PILL_IDLE_WIDTH = 44;
const PILL_IDLE_HEIGHT = 22;
// Static layout anchor: positions the idle pill within the 480px window
// based on the SUM of all rendered children (incl. opacity-0 siblings).
// Idle layout: [Home(28)] + 8 + [Dictate pill(44)] + 8 + [Take Notes(~120)]
// = 208. With justify-center, the group's left edge sits at
// (480 - 208) / 2 = 136. The Dictate pill is the SECOND child of the
// group, so its left edge is at group-left + Home(28) + gap(8) = 172.
// Get this wrong and drag clamping doesn't match the rendered pill
// position → pill can be dragged off-screen.
const HOVER_GROUP_WIDTH = 208;
const HOME_BUTTON_WIDTH = 28;
const GROUP_GAP = 8;
const PILL_OFFSET_X =
  Math.round((HUD_WIDTH - HOVER_GROUP_WIDTH) / 2) + HOME_BUTTON_WIDTH + GROUP_GAP;
// Dynamic visible bounds in hover-idle: Home(28) + 8 gap + main pill
// (expanded ~140) + 8 gap + Take Notes pill(~120) ≈ 304. Used only by the
// workArea clamping check below — if the user has the HUD dragged near
// a screen edge, this is the bounds we don't want to overflow.
const HOVER_GROUP_VISIBLE_WIDTH = 304;
const PILL_OFFSET_Y = (HUD_HEIGHT - PILL_IDLE_HEIGHT) / 2; // 51

// Threshold (px) for declaring the pill "near" an edge — used to flip the
// hover-group expansion direction in the renderer. 12 px gives a small
// buffer so micro-jitter doesn't keep toggling the anchor.
const EDGE_ANCHOR_THRESHOLD_PX = 12;

/**
 * Visual-state → expected-visible-bounds in the HUD window. Used for the
 * banner / large-state repositioning logic: when the renderer enters one
 * of these states, main checks whether the bounds would extend past the
 * display's workArea at the user's drag anchor. If so, main shifts the
 * window the minimum distance needed to fit, then restores the window to
 * the anchor when the state returns to one that fits.
 *
 * Bounds are CONSERVATIVE — they assume the visible content centers
 * horizontally + vertically inside the window. The hover/recording states
 * are small enough that they always fit at any drag anchor; only the
 * banner states (failed, disconnected) can actually trigger a shift.
 */
const VISUAL_BOUNDS: Record<HudPillVisual, { width: number; height: number }> = {
  idle: { width: PILL_IDLE_WIDTH, height: PILL_IDLE_HEIGHT },
  hoverIdle: { width: HOVER_GROUP_VISIBLE_WIDTH, height: 28 },
  busy: { width: 80, height: 32 },
  recording: { width: 140, height: 32 },
  processing: { width: 60, height: 32 },
  failed: { width: 400, height: 100 },
  dictationLimit: { width: 400, height: 100 },
  disconnected: { width: 400, height: 100 },
};

export class FloatingHudWindow {
  private readonly win: BrowserWindow;
  /**
   * User's preferred window position — set on drag-end. State-change
   * repositioning compares against this; when the visual state collapses
   * back to one that fits at the anchor, we restore to it.
   */
  private anchorPos: { x: number; y: number } | null = null;
  /**
   * Last visual state the renderer reported. Used by the orchestration to
   * decide window position whenever something changes (state, drag, display).
   */
  private currentVisual: HudPillVisual = 'idle';
  /**
   * Optional emitter for edge-anchor pushes to the renderer (so it can flip
   * the hover-group expansion direction). Wired by main after the bridge is
   * available; no-op until then.
   */
  private edgeAnchorPusher: ((anchor: HudEdgeAnchor) => void) | null = null;
  /** Cache so we don't fire EDGE_ANCHOR pushes when nothing changed. */
  private lastEdgeAnchor: HudEdgeAnchor | null = null;

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
    // is dictating into. `visibleOnFullScreen: true` is needed so the HUD
    // doesn't disappear when any other app goes fullscreen.
    // `skipTransformProcessType: true` (V1 carries this) stops Electron
    // from auto-toggling the app's UIElement / Foreground process type as
    // a side effect — without it, setting `visibleOnAllWorkspaces(true)`
    // can silently demote the app to UIElement on some macOS versions and
    // confuse the Dock-visibility logic in createMainWindow.
    this.win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });

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
    const targetX = Math.round(this.dragSnapshot.x + dx);
    const targetY = Math.round(this.dragSnapshot.y + dy);
    const { x: clampedX, y: clampedY } = clampPillToWorkArea(targetX, targetY);
    this.win.setPosition(clampedX, clampedY);
    // Push the new edge-anchor based on where the pill actually landed.
    // Renderer uses this to flip hover-group expansion direction so the
    // Take-notes / Home buttons don't render past the screen edge.
    this.maybePushEdgeAnchor(clampedX, clampedY);
  }

  endDrag(): void {
    this.dragSnapshot = null;
    // Persist the post-drag position as the user's anchor — state-change
    // repositioning will return here when the visual collapses to something
    // that fits.
    const b = this.win.getBounds();
    this.anchorPos = { x: b.x, y: b.y };
  }

  /**
   * Wired by main after the IPC bridge exists so we can push edge-anchor
   * updates to the renderer. Calling without a pusher set is a no-op.
   */
  setEdgeAnchorPusher(pusher: (anchor: HudEdgeAnchor) => void): void {
    this.edgeAnchorPusher = pusher;
    // Push the current anchor on first wire-up so the renderer starts
    // with a correct value.
    const b = this.win.getBounds();
    this.maybePushEdgeAnchor(b.x, b.y);
  }

  /**
   * Renderer notifies us whenever its pill visual changes. We may need to
   * shift the window so the larger states (banner: 400 × 100) fit inside
   * the workArea even if the user dragged the idle pill near an edge.
   * When the state returns to one that fits at the anchor, we restore.
   */
  setVisualState(visual: HudPillVisual): void {
    if (this.win.isDestroyed()) return;
    this.currentVisual = visual;
    // Lazy-init anchor: if the user hasn't dragged yet, the current window
    // position IS the anchor (= initial placeOnActiveDisplay).
    if (this.anchorPos === null) {
      const b = this.win.getBounds();
      this.anchorPos = { x: b.x, y: b.y };
    }
    const target = computeWindowPosForState(visual, this.anchorPos);
    const current = this.win.getBounds();
    if (current.x !== target.x || current.y !== target.y) {
      this.win.setPosition(target.x, target.y);
      this.maybePushEdgeAnchor(target.x, target.y);
    }
  }

  /** Compute + diff + push edge anchor; cheap no-op when unchanged. */
  private maybePushEdgeAnchor(winX: number, winY: number): void {
    if (!this.edgeAnchorPusher) return;
    const cursor = screen.getCursorScreenPoint();
    const wa = screen.getDisplayNearestPoint(cursor).workArea;
    const pillLeft = winX + PILL_OFFSET_X;
    const pillRight = pillLeft + PILL_IDLE_WIDTH;
    const pillTop = winY + PILL_OFFSET_Y;
    const pillBottom = pillTop + PILL_IDLE_HEIGHT;
    const x: HudEdgeAnchor['x'] =
      pillLeft - wa.x <= EDGE_ANCHOR_THRESHOLD_PX
        ? 'left'
        : wa.x + wa.width - pillRight <= EDGE_ANCHOR_THRESHOLD_PX
          ? 'right'
          : 'center';
    const y: HudEdgeAnchor['y'] =
      pillTop - wa.y <= EDGE_ANCHOR_THRESHOLD_PX
        ? 'top'
        : wa.y + wa.height - pillBottom <= EDGE_ANCHOR_THRESHOLD_PX
          ? 'bottom'
          : 'center';
    const next: HudEdgeAnchor = { x, y };
    const prev = this.lastEdgeAnchor;
    if (prev && prev.x === next.x && prev.y === next.y) return;
    this.lastEdgeAnchor = next;
    this.edgeAnchorPusher(next);
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

/**
 * Clamp a candidate window (x, y) so the idle pill bounds stay inside the
 * cursor-nearest display's workArea. The transparent surround is allowed
 * to extend past workArea on every side — only the visible 44 × 22 pill
 * is constrained. Using `workArea` (not `display.bounds`) means the top
 * edge respects the macOS menu bar and the bottom edge respects the dock.
 */
function clampPillToWorkArea(targetX: number, targetY: number): { x: number; y: number } {
  const cursor = screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint(cursor).workArea;
  // Pill spans (winX + PILL_OFFSET_X, winY + PILL_OFFSET_Y) to
  // (winX + PILL_OFFSET_X + PILL_IDLE_WIDTH, winY + PILL_OFFSET_Y + PILL_IDLE_HEIGHT).
  // Solve for winX such that PILL stays in [wa.x, wa.x + wa.width].
  const minX = wa.x - PILL_OFFSET_X;
  const maxX = wa.x + wa.width - PILL_OFFSET_X - PILL_IDLE_WIDTH;
  const minY = wa.y - PILL_OFFSET_Y;
  const maxY = wa.y + wa.height - PILL_OFFSET_Y - PILL_IDLE_HEIGHT;
  return {
    x: Math.max(minX, Math.min(targetX, maxX)),
    y: Math.max(minY, Math.min(targetY, maxY)),
  };
}

/**
 * Compute the window position required so the visible bounds for `visual`
 * fit inside the cursor-nearest display's workArea. Starts from the user's
 * anchor (drag-end position) and shifts MINIMALLY to fit.
 *
 * For small states (idle, hover, recording, processing) the anchor always
 * fits — we return it unchanged. For banner states (failed, disconnected)
 * the visible content is 400 × 100, much wider than any per-edge slack
 * the pill-bounds clamp leaves, so the window has to shift inward. When
 * the state returns to a small one, the caller restores to the anchor.
 *
 * Visible content for a state is assumed centered horizontally + vertically
 * in the HUD window (which matches the renderer's `items-center justify-center`
 * outer flex).
 */
function computeWindowPosForState(
  visual: HudPillVisual,
  anchor: { x: number; y: number },
): { x: number; y: number } {
  const bounds = VISUAL_BOUNDS[visual];
  // Visible content centered in the window:
  const offsetX = Math.round((HUD_WIDTH - bounds.width) / 2);
  const offsetY = Math.round((HUD_HEIGHT - bounds.height) / 2);
  // Use the display the ANCHOR is on, not the cursor — the cursor might be
  // anywhere when a state changes asynchronously (e.g., backend reports
  // failure while user's mouse is in another window).
  const wa = screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y }).workArea;
  const minX = wa.x - offsetX;
  const maxX = wa.x + wa.width - offsetX - bounds.width;
  const minY = wa.y - offsetY;
  const maxY = wa.y + wa.height - offsetY - bounds.height;
  return {
    x: Math.max(minX, Math.min(anchor.x, maxX)),
    y: Math.max(minY, Math.min(anchor.y, maxY)),
  };
}
