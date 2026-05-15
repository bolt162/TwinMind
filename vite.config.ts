/**
 * Vite config — multi-page renderer build.
 *
 * Two entry points: the main app window (`index.html`) and the floating
 * HUD overlay (`hud.html`). Each gets its own bundle so the HUD's tiny
 * payload doesn't include settings/onboarding code.
 *
 * Dev: `npm run dev:renderer` serves both at http://localhost:5173/ with
 * `/index.html` and `/hud.html` paths.
 * Prod: `npm run build:renderer` emits to `dist/renderer/`.
 */

import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  // electron-builder + loadFile both need relative paths in the prod bundle.
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'src/renderer/index.html'),
        hud: path.resolve(__dirname, 'src/renderer/hud.html'),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@ipc': path.resolve(__dirname, 'src/ipc'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      // Renderer imports the shared Hotkey types from core. Only that one
      // file is renderer-safe today; if more @core imports are added, audit
      // them for Node-only deps before exposing the whole tree.
      '@core': path.resolve(__dirname, 'src/core'),
    },
  },
});
