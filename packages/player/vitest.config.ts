import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

// Unit tests (`src/**/*.test.ts`) run in Node with fakes. Browser tests (`browser/**/*.test.ts`)
// drive the built player in headless Chromium through Playwright; see browser/README.md.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'browser/**/*.test.ts'],
    globalSetup: ['browser/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // At least two files at once. Vitest's default is one fewer than the cores, so CI's two-core runner
    // ran one file at a time: templates.test.ts (about 11 min) and then the rest (about 7 min), mostly
    // waiting on the page. Each file has its own browser and fixture servers (harness.ts).
    maxWorkers: Math.max(2, availableParallelism() - 1),
  },
});
