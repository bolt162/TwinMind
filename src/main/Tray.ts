/**
 * TrayManager — macOS menu-bar icon with a two-item menu.
 *
 *   Home              → opens the main window on the current Space.
 *   ─────────────
 *   Quit TwinMind     → terminates the app via the normal before-quit path.
 *
 * Icon: loaded from a real PNG file in `resources/tray/` (16×16 + 32×32 @2x).
 * Falls back to a runtime-generated black-dot bitmap so dev environments
 * without a packaged copy of `resources/` still get a working tray. Template-
 * image semantics make the silhouette auto-tint for dark / light menu bars.
 *
 * Once the app falls back to "tray-only" mode (main window destroyed,
 * Dock icon hidden), this icon is the user's only persistent access point.
 * Failures are logged at error so support has something to look at.
 */

import path from 'node:path';
import fs from 'node:fs';
import { app, Menu, nativeImage, Tray, type NativeImage } from 'electron';
import { type Logger, noopLogger } from '@core/observability/Logger';

export interface TrayManagerDeps {
  /** Opens the main window's Home tab. Provided by main.ts. */
  readonly onOpenHome: () => void;
  /** Logger for diagnosing init failures in the field. */
  readonly logger?: Logger;
}

export class TrayManager {
  private tray: Tray | null = null;
  private readonly logger: Logger;

  constructor(private readonly deps: TrayManagerDeps) {
    this.logger = deps.logger ?? noopLogger;
  }

  /**
   * Create the tray icon + menu. Safe to call multiple times — re-init is a
   * no-op while a tray already exists. Returns whether the tray is now
   * present (false on macOS / Windows construction failure).
   */
  init(): boolean {
    if (this.tray) return true;
    if (process.platform !== 'darwin' && process.platform !== 'win32') return false;

    const icon = loadTrayIcon(this.logger);
    if (!icon || icon.isEmpty()) {
      this.logger.error('tray-init failed: icon empty or missing');
      return false;
    }

    try {
      this.tray = new Tray(icon);
    } catch (err) {
      this.logger.error('tray-init failed: new Tray() threw', {
        message: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    this.tray.setToolTip('TwinMind');

    if (process.platform === 'darwin') {
      // Avoid the click-then-doubleClick stutter that causes the menu to
      // flicker shut and back open on a fast double-click.
      this.tray.setIgnoreDoubleClickEvents(true);
    }

    this.tray.setContextMenu(this.buildMenu());
    this.logger.info('tray initialized');
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
 * Locate the bundled tray-icon PNG. `extraResources` copies `resources/tray`
 * to `Contents/Resources/tray/` in packaged builds; in dev we look two levels
 * above the compiled `dist/main/` for the repo's `resources/tray`.
 */
function resolveTrayIconPath(): string | null {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'tray', 'iconTemplate.png')]
    : [
        path.join(__dirname, '..', '..', 'resources', 'tray', 'iconTemplate.png'),
        path.join(process.cwd(), 'resources', 'tray', 'iconTemplate.png'),
      ];
  return candidates.find((p) => fileExists(p)) ?? null;
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function loadTrayIcon(logger: Logger): NativeImage | null {
  const pngPath = resolveTrayIconPath();
  if (pngPath) {
    const img = nativeImage.createFromPath(pngPath);
    if (!img.isEmpty()) {
      if (process.platform === 'darwin') img.setTemplateImage(true);
      return img;
    }
    logger.warn('tray-icon PNG loaded as empty image', { pngPath });
  } else {
    logger.warn('tray-icon PNG not found; falling back to runtime bitmap');
  }
  return buildFallbackBitmap();
}

/** Fallback: tiny 16×16 black circle bitmap. Same shape as the shipped PNG. */
function buildFallbackBitmap(): NativeImage {
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
