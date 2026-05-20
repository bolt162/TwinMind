#!/usr/bin/env node
/**
 * Build the main + preload + audio-process bundles with esbuild.
 *
 * Why esbuild instead of plain tsc: tsc emits one .js per .ts and leaves
 * path-aliases (`@core/*`, `@ipc/*`) unresolved in the output. Bundling
 * collapses everything into one .js per entry and inlines the migration
 * SQL string, which removes runtime path resolution as a failure mode.
 *
 * The renderer is built separately by Vite (`npm run build:renderer`).
 */

const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const dotenv = require('dotenv');

const repoRoot = path.resolve(__dirname, '..');
const distDir = path.join(repoRoot, 'dist');

/**
 * Env vars baked into the bundle as `process.env.X` → literal-string
 * replacements via esbuild's `define`. These are PUBLIC identifiers
 * (Firebase project, OAuth client id, backend URLs, Vercel bypass) — none
 * are user credentials. The actual secret (the Firebase refresh token) is
 * encrypted in macOS Keychain at runtime.
 *
 * Reading order: real `process.env` first (so CI / launch-time overrides
 * win), then `.env` in the repo root as a fallback. Vars absent in BOTH
 * compile to literal `undefined` in the bundle; the runtime
 * `resolveTwinMindBackendConfig` surfaces them as `missing` to Settings.
 */
const BAKED_VARS = [
  'FIREBASE_WEB_API_KEY',
  'FIREBASE_TENANT_ID',
  'FIREBASE_PROJECT_ID',
  'TWINMIND_BACKEND_URL',
  'VERCEL_PROTECTION_BYPASS',
  'TWINMIND_TRANSCRIBE_URL',
  'TWINMIND_SUMMARY_URL',
  // Optional — fall back to V1's defaults in twinmindBackendConfig.ts when
  // unset, so missing values aren't surfaced as "Backend not configured".
  'TWINMIND_DICTATION_MODEL',
  'TWINMIND_MEETING_MODEL',
  'TWINMIND_APP_URL',
  'TWINMIND_WEB_LOGIN_URL',
];

const OPTIONAL_VARS = new Set([
  'TWINMIND_DICTATION_MODEL',
  'TWINMIND_MEETING_MODEL',
  'TWINMIND_APP_URL',
  'TWINMIND_WEB_LOGIN_URL',
]);

/** Subset of BAKED_VARS that the UI surfaces as "missing" if absent. */
const REQUIRED_VARS = BAKED_VARS.filter((n) => !OPTIONAL_VARS.has(n));

function loadBakedEnv() {
  // dotenv reads `.env` but does NOT overwrite values already in process.env,
  // which gives CI / shell-set vars precedence — what we want.
  dotenv.config({ path: path.join(repoRoot, '.env') });
  const out = {};
  const missingRequired = [];
  for (const name of BAKED_VARS) {
    const v = process.env[name];
    if (typeof v === 'string' && v.trim().length > 0) {
      out[name] = v.trim();
    } else if (REQUIRED_VARS.includes(name)) {
      missingRequired.push(name);
    }
  }
  if (missingRequired.length > 0) {
    console.warn(
      `▸ build.cjs: missing env vars (Settings → Account will show this list to the user): ${missingRequired.join(', ')}`,
    );
  }
  return out;
}

/** Build the `define` map esbuild uses to replace process.env.X references. */
function buildDefineMap() {
  const baked = loadBakedEnv();
  const define = {};
  for (const name of BAKED_VARS) {
    // JSON.stringify yields a quoted JS string literal; `undefined` → 'undefined'.
    define[`process.env.${name}`] = JSON.stringify(baked[name] ?? null) === 'null'
      ? 'undefined'
      : JSON.stringify(baked[name]);
  }
  return define;
}

/**
 * Native / Electron / worker-spawning deps that must stay external.
 *
 * Pino is here because it spawns transport + destination workers via
 * `thread-stream` / `worker_threads`. If pino is bundled into main.js, the
 * worker can't resolve its own transitive deps (pino-pretty, sonic-boom, …)
 * and crashes immediately with "the worker thread exited". Keeping pino and
 * its workers external preserves normal node_modules resolution.
 */
const EXTERNAL = [
  'electron',
  'better-sqlite3',
  'audiotee',
  'uiohook-napi',
  'ffmpeg-static',
  '@sentry/electron',
  '@twinmind/coreaudio-darwin',
  // Pino ecosystem — must remain external for worker resolution to work.
  'pino',
  'pino-pretty',
  'thread-stream',
  'sonic-boom',
  'pino-abstract-transport',
  'pino-std-serializers',
  '@pinojs/redact',
];

/** Resolve the TS path-aliases declared in `tsconfig.base.json`. */
const ALIASES = {
  '@core': path.join(repoRoot, 'src/core'),
  '@platform': path.join(repoRoot, 'src/platform'),
  '@ipc': path.join(repoRoot, 'src/ipc'),
  '@audio-process': path.join(repoRoot, 'src/audio-process'),
};

/**
 * esbuild plugin: rewrite `@core/foo` → absolute path resolved from the alias
 * map. Cheap and explicit; avoids pulling in tsconfig-paths plugins.
 */
function aliasPlugin() {
  return {
    name: 'twinmind-aliases',
    setup(build) {
      const aliases = Object.entries(ALIASES);
      build.onResolve({ filter: /^@/ }, (args) => {
        for (const [prefix, base] of aliases) {
          if (args.path === prefix || args.path.startsWith(`${prefix}/`)) {
            const rest = args.path === prefix ? '' : args.path.slice(prefix.length + 1);
            const candidate = rest ? path.join(base, rest) : base;
            // Try .ts / .tsx / .js / .json + index.* fallbacks.
            const tries = [
              candidate,
              `${candidate}.ts`,
              `${candidate}.tsx`,
              `${candidate}.js`,
              path.join(candidate, 'index.ts'),
              path.join(candidate, 'index.tsx'),
              path.join(candidate, 'index.js'),
            ];
            for (const t of tries) {
              if (fs.existsSync(t) && fs.statSync(t).isFile()) {
                return { path: t };
              }
            }
            return { errors: [{ text: `cannot resolve alias ${args.path}` }] };
          }
        }
        return null;
      });
    },
  };
}

const DEFINE = buildDefineMap();

const COMMON = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: 'inline',
  external: EXTERNAL,
  plugins: [aliasPlugin()],
  // Inline build-time env vars. Only the TwinMind/Firebase/Google PUBLIC
  // identifiers — see BAKED_VARS for the exhaustive list.
  define: DEFINE,
  // Electron's `require()` path resolution drops alongside the entry file, so
  // emit each entry into its own subdirectory.
  logLevel: 'info',
};

/** Build a single entry, swallowing exceptions so we can chain in dev mode. */
async function build(entry, outfile) {
  return esbuild.build({ ...COMMON, entryPoints: [entry], outfile });
}

async function main() {
  fs.mkdirSync(path.join(distDir, 'main'), { recursive: true });
  fs.mkdirSync(path.join(distDir, 'audio-process'), { recursive: true });

  await Promise.all([
    build('src/main.ts', path.join(distDir, 'main/main.js')),
    build('src/preload.ts', path.join(distDir, 'main/preload.js')),
    build('src/audio-process/entry.ts', path.join(distDir, 'audio-process/entry.js')),
  ]);

  console.log('✓ main / preload / audio-process bundled');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
