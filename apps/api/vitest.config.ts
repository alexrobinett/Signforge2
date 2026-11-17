import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd with the bindings from wrangler.jsonc, backed by local storage.
// ADMIN_TOKEN is a fixed test value here, so a local .dev.vars never changes what the tests see.
// `test/setup.ts` applies packages/db's migrations, the same ones `wrangler d1 migrations apply` runs.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { bindings: { ADMIN_TOKEN: 'test-admin-token', TEST_MIGRATIONS: await readD1Migrations(new URL('../../packages/db/migrations', import.meta.url).pathname) } },
    })),
  ],
  test: { setupFiles: ['test/setup.ts'] },
});
