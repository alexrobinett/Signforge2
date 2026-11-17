import { defineConfig } from 'vitest/config';

// Unit tests only; the end-to-end run against the local API is `pnpm test:e2e` (Playwright).
export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
});
