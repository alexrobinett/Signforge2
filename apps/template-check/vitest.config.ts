import { defineConfig } from 'vitest/config';

// The runner's tests drive headless Chromium; the container's (`test:container`) are separate.
export default defineConfig({
  test: { include: ['test/check.test.ts', 'test/server.test.ts', 'test/image.test.ts', 'test/sample.test.ts'], testTimeout: 30_000, hookTimeout: 30_000 },
});
