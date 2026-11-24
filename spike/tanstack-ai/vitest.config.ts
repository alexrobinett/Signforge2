import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The Worker runs inside workerd with local D1, packages/db's migrations applied by test/setup.ts,
// and the scripted model (MODEL_STUB=on in wrangler.jsonc): no key, no network.
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations(new URL('../../packages/db/migrations', import.meta.url).pathname) } },
    }),
  ],
  test: { setupFiles: ['test/setup.ts'] },
}));
