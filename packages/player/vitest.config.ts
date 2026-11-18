import { defineConfig } from 'vitest/config';

// Unit tests (`src/**/*.test.ts`) run in Node with fakes. Browser tests (`browser/**/*.test.ts`)
// drive the built player in headless Chromium through Playwright; see browser/README.md.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'browser/**/*.test.ts'],
    globalSetup: ['browser/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
