import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd, the runtime the poller uses, so a dependency that does not bundle
// for Workers fails here rather than in production.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: { compatibilityDate: '2026-11-01', compatibilityFlags: ['nodejs_compat'] },
    }),
  ],
});
