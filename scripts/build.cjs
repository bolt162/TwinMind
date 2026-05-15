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

const repoRoot = path.resolve(__dirname, '..');
const distDir = path.join(repoRoot, 'dist');

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

const COMMON = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: 'inline',
  external: EXTERNAL,
  plugins: [aliasPlugin()],
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
