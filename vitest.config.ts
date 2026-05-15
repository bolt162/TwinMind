import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Vitest config covers ONLY the unit + integration tests under tests/.
// Playwright (tests/e2e) is configured separately in playwright.config.ts.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // Pure-logic units should be sub-millisecond; integration uses tmp dirs.
    testTimeout: 5_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/core/**/*.ts'],
      exclude: ['**/*.d.ts'],
    },
  },
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
      '@platform': path.resolve(__dirname, 'src/platform'),
      '@ipc': path.resolve(__dirname, 'src/ipc'),
      '@audio-process': path.resolve(__dirname, 'src/audio-process'),
    },
  },
});
