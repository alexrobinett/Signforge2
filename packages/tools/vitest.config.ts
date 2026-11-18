import { readFileSync } from 'node:fs';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tools run inside workerd against a local D1 with packages/db's migrations and a local R2.
// The video tests get media-check's ffmpeg-made clips, base64 by name, as a binding.
const clips = ['high.mp4', 'fps60.mp4', 'main-moov-at-end.mp4'];
const clipDir = new URL('../media-check/test/fixtures/', import.meta.url);
const VIDEO_CLIPS = JSON.stringify(Object.fromEntries(clips.map((c) => [c, readFileSync(new URL(c, clipDir).pathname).toString('base64')])));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      miniflare: {
        compatibilityDate: '2026-11-01',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DB'],
        r2Buckets: ['BLOBS'],
        bindings: { TEST_MIGRATIONS: await readD1Migrations(new URL('../db/migrations', import.meta.url).pathname), VIDEO_CLIPS },
      },
    })),
  ],
  // test/e2e runs in Node, with a browser: vitest.e2e.config.ts.
  test: { setupFiles: ['test/setup.ts'], exclude: ['test/e2e/**', '**/node_modules/**'] },
});
