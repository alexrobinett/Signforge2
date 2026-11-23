import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The round trip runs inside workerd with local D1. Each test sends tens of requests, each building
// Better Auth: the end-to-end one took 6.9 s on CI's runner (run 45113366381), against about 0.2 s
// on a laptop, over Vitest's 5 s default. 30 s, as packages/player and apps/template-check allow.
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations('./migrations') } },
    }),
  ],
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
}));
