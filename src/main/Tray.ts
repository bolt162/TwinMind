/**
 * TrayManager — macOS menu-bar icon with a two-item menu.
 *
 *   Home              → opens the main window on the current Space.
 *   ─────────────
 *   Quit TwinMind     → terminates the app via the normal before-quit path.
 *
 * Minimal on purpose: V1 had show/hide-HUD and Settings-driven visibility,
 * but the user explicitly asked for the bare minimum here. Add items later
 * by extending `buildMenuTemplate()`.
 */

import { app, Menu, nativeImage, Tray, type NativeImage } from 'electron';

export interface TrayManagerDeps {
  /** Opens the main window's Home tab. Provided by main.ts. */
  readonly onOpenHome: () => void;
}

export class TrayManager {
  private tray: Tray | null = null;

  constructor(private readonly deps: TrayManagerDeps) {}

  /**
   * Create the tray icon + menu. Safe to call multiple times — re-init is a
   * no-op while a tray already exists. Returns whether the tray is now
   * present (false on macOS / Windows construction failure).
   */
  init(): boolean {
    if (this.tray) return true;
    if (process.platform !== 'darwin' && process.platform !== 'win32') return false;

    const icon = loadTrayIcon();
    if (!icon || icon.isEmpty()) return false;

    this.tray = new Tray(icon);
    this.tray.setToolTip('TwinMind');

    if (process.platform === 'darwin') {
      // Avoid the click-then-doubleClick stutter that causes the menu to
      // flicker shut and back open on a fast double-click.
      this.tray.setIgnoreDoubleClickEvents(true);
    }

    this.tray.setContextMenu(this.buildMenu());
    return true;
  }

  /** Tear down the tray (called from before-quit). Idempotent. */
  destroy(): void {
    if (!this.tray) return;
    this.tray.destroy();
    this.tray = null;
  }

  private buildMenu(): Menu {
    return Menu.buildFromTemplate([
      {
        label: 'Home',
        click: () => this.deps.onOpenHome(),
      },
      { type: 'separator' },
      {
        label: 'Quit TwinMind',
        click: () => app.quit(),
      },
    ]);
  }
}

/**
 * Generate a generic 16×16 tray icon at runtime: a small black filled
 * circle on a transparent background. Self-contained — no asset file to
 * ship, no sizing surprises (we control the raw bitmap dimensions
 * directly, so macOS sees a 16×16 logical icon and renders at the
 * standard menu-bar size).
 *
 * macOS template-image flag makes the circle auto-tint for the dark or
 * light menu bar. Drop a real branded `iconTemplate@2x.png` into
 * `resources/` and load it via `nativeImage.createFromPath` here later
 * when you want the TwinMind brand back.
 */
function loadTrayIcon(): NativeImage {
  const SIZE = 16;
  const RADIUS = 5;
  const bitmap = Buffer.alloc(SIZE * SIZE * 4);
  const center = (SIZE - 1) / 2;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - center;
      const dy = y - center;
      const inside = Math.sqrt(dx * dx + dy * dy) <= RADIUS;
      const offset = (y * SIZE + x) * 4;
      // Black RGB, alpha 255 inside the circle, 0 (transparent) outside.
      // Template-image mode treats RGB as the silhouette and uses alpha for
      // coverage — macOS recolors the silhouette per menu-bar theme.
      bitmap[offset] = 0;
      bitmap[offset + 1] = 0;
      bitmap[offset + 2] = 0;
      bitmap[offset + 3] = inside ? 255 : 0;
    }
  }
  const img = nativeImage.createFromBitmap(bitmap, { width: SIZE, height: SIZE });
  if (!img.isEmpty() && process.platform === 'darwin') {
    img.setTemplateImage(true);
  }
  return img;
}
