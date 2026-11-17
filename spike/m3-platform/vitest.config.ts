import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Local proofs run inside workerd with local D1, R2 and Durable Objects. The deployed runs on
// real Cloudflare are in scripts/ and their output in RESULTS.md.
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations('./migrations') } },
    }),
  ],
}));
