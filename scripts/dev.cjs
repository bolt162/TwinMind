#!/usr/bin/env node
/**
 * Dev launcher: builds + starts everything for `npm run dev`.
 *
 * Steps:
 *  1. Run `scripts/build.cjs` once to emit main/preload/audio-process bundles.
 *  2. Spawn the Vite dev server (background) for the renderer (HUD + main HTML).
 *  3. Wait for vite to start serving (http://localhost:5173).
 *  4. Launch Electron pointing at the bundled main.js.
 *  5. When Electron exits, kill the vite child and exit.
 *
 * Hot reload covers the renderer (Vite HMR). Main-process / audio-process
 * changes need a full restart — Cmd-Q the app and re-run `npm run dev`.
 *
 * Recommended defaults for mock testing (no native addon, no API key):
 *     TWINMIND_MIC_BACKEND=mock_sine TWINMIND_ASR_PROVIDER=mock npm run dev
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const waitOn = require('wait-on');

const repoRoot = path.resolve(__dirname, '..');

/**
 * Track which runtime the native modules were last rebuilt for. `switch:app`
 * and `switch:tests` each stamp this file; dev launches read it and re-run
 * `switch:app` automatically if a test run last bound them to host Node.
 * Without this, every test→run cycle ends in an ABI-mismatch crash.
 */
const ABI_MARKER = path.join(repoRoot, 'node_modules', '.twinmind-native-abi');
function readAbiMarker() {
  try {
    return fs.readFileSync(ABI_MARKER, 'utf8').trim();
  } catch {
    return null;
  }
}

/** Run one command, inheriting stdio, return a promise resolved on exit. */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', cwd: repoRoot, ...opts });
    child.on('exit', (code) => (code === 0 ? resolve(0) : reject(new Error(`${cmd} exited ${code}`))));
    child.on('error', reject);
  });
}

/** Spawn a long-running child whose lifetime is bound to ours. */
function background(cmd, args, env = {}) {
  const child = spawn(cmd, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  return child;
}

async function main() {
  // Step -1: ensure native modules are bound to Electron's ABI. The marker is
  // written by `switch:app` / `switch:tests`; a missing or wrong marker means
  // we need to rebuild before launching, otherwise better-sqlite3 etc. won't
  // load in the Electron process.
  const abi = readAbiMarker();
  if (abi !== 'electron') {
    console.log(
      `▸ native modules last built for ${abi ?? 'unknown'} — rebuilding for Electron…`,
    );
    await run('npm', ['run', 'switch:app']);
  }

  // Step 1: build main + preload + audio-process bundles once.
  console.log('▸ building main/preload/audio-process via esbuild…');
  await run('node', ['scripts/build.cjs']);

  // Step 2: start vite for the renderer (HUD + main).
  console.log('▸ starting vite dev server on http://localhost:5173 …');
  const vite = background('npx', ['vite']);

  // Step 3: wait for vite to actually serve.
  await waitOn({ resources: ['http://localhost:5173'], timeout: 30_000 });

  // Step 4: launch Electron. NODE_ENV=development makes main.ts load the
  // renderer from the dev server instead of dist/renderer files.
  console.log('▸ launching Electron…');
  const electronBin = require('electron');
  const electron = spawn(electronBin, ['.'], {
    cwd: repoRoot,
    env: { ...process.env, NODE_ENV: 'development' },
    stdio: 'inherit',
  });

  // Step 5: tie lifecycles. When electron exits, kill vite and exit ourselves.
  const cleanup = () => {
    try {
      vite.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  };
  electron.on('exit', (code) => {
    cleanup();
    process.exit(code ?? 0);
  });
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
