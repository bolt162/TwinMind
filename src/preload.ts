/**
 * preload.ts — the renderer's bridge.
 *
 * Architecture: §4 (narrow typed IPC), §12.7 (contextIsolation: true).
 *
 * Imports `bridge.preload.ts` for its side effect — exposing `electronAPI` via
 * `contextBridge.exposeInMainWorld`. This file exists so `webPreferences.preload`
 * can point at a single compiled `.js` regardless of whether we restructure
 * the IPC layer's internals.
 */

import './ipc/bridge.preload';
