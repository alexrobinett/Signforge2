import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Two projects: the repositories run inside workerd against a local D1 with the real
// migrations applied; the import-boundary check runs in Node, where it can read the repo.
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest(async () => ({
            miniflare: {
              compatibilityDate: '2026-11-01',
              compatibilityFlags: ['nodejs_compat'],
              d1Databases: ['DB'],
              bindings: { TEST_MIGRATIONS: await readD1Migrations(new URL('./migrations', import.meta.url).pathname) },
            },
          })),
        ],
        test: { name: 'workers', include: ['test/*.test.ts'], setupFiles: ['test/setup.ts'] },
      },
      { test: { name: 'node', include: ['test/node/*.test.ts'], environment: 'node' } },
    ],
  },
});
