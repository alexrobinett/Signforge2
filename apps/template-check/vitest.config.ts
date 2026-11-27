import { defineConfig } from 'vitest/config';
import { frameHostScript } from './frame-host-script.ts';

// The runner's tests drive headless Chromium; the container's (`test:container`) are separate.
export default defineConfig(async () => ({
  define: { __SF_FRAME_HOST__: JSON.stringify(await frameHostScript()) },
  test: {
    include: ['test/check.test.ts', 'test/server.test.ts', 'test/image.test.ts', 'test/sample.test.ts', 'test/slots.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
}));
