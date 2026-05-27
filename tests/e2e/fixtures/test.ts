/**
 * Shared Playwright fixture wrapping `launchApp` so every spec gets an
 * isolated TestApp and automatic teardown without per-test boilerplate.
 *
 * Usage:
 *   import { test, expect } from './fixtures/test';
 *   test('foo', async ({ app }) => { ... });
 */

import { test as base, expect } from '@playwright/test';
import { launchApp, type TestApp } from './app';

type AppFixtures = {
  app: TestApp;
};

export const test = base.extend<AppFixtures>({
  app: async ({}, use) => {
    const app = await launchApp();
    try {
      await use(app);
    } finally {
      await app.close();
    }
  },
});

export { expect };
