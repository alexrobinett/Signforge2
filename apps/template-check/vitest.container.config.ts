import { defineConfig } from 'vitest/config';

// `pnpm test:container`: the check Worker under `wrangler dev`, with its container (Docker).
export default defineConfig({
  test: {
    include: ['test/container.test.ts'],
    globalSetup: ['test/wrangler-dev.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
