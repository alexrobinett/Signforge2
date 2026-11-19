import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests only; the end-to-end run against the local API is `pnpm test:e2e` (Playwright).
export default defineConfig({
  // The app's own import path, so the store's slices can be tested as they are written.
  resolve: { alias: { '~': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { include: ['test/**/*.test.ts'] },
});
