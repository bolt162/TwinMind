/**
 * HUD entry point. Mounts the floating mic-button overlay into the
 * `FloatingHudWindow` (see `src/main/FloatingHudWindow.ts`).
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import { HudApp } from './HudApp';

const root = document.getElementById('root');
if (!root) throw new Error('HUD: #root not found');
createRoot(root).render(
  <React.StrictMode>
    <HudApp />
  </React.StrictMode>,
);
