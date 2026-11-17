import { defineConfig } from 'vitest/config';

// The browser upload test: Node drives Chromium (Playwright) and a Miniflare Worker running the
// dispatcher with local D1 and R2. See test/e2e/upload.test.ts.
export default defineConfig({
  test: { include: ['test/e2e/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 },
});
