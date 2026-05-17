/**
 * Main window entry. The full Settings / Sessions / Onboarding UI mounts
 * here. For now this is a thin placeholder; the HUD carries the MVP UX.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('main: #root not found');
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
