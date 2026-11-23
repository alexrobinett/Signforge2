import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The Worker runs in workerd with wrangler.jsonc's bucket, backed by local storage, and fixed test tokens.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { bindings: { TURBO_TOKEN: 'test-write-token', TURBO_READ_TOKEN: 'test-read-token' } },
    }),
  ],
});
