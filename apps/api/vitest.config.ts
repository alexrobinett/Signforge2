import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { buildTemplate } from '@signforge/cli/template';
// The fonts entry, not the index: Node loads this config, and the compiler's index uses extensionless imports.
import { FONTS, fontFilePath } from '@signforge/compiler/fonts';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd with the bindings of wrangler.jsonc's `dev` environment, backed by local storage.
// ADMIN_TOKEN is a fixed test value here, so a local .dev.vars never changes what the tests see.
// `test/setup.ts` applies packages/db's migrations, the same ones `wrangler d1 migrations apply` runs.
// TEMPLATE_BUILDS holds every template in templates/, built here in Node as `sf template push`
// builds them (esbuild cannot run in workerd), for test/templates.test.ts to push.
async function templateBuilds() {
  const root = new URL('../../templates/', import.meta.url).pathname;
  const builds = [];
  // Only folders that hold a template: a stray .DS_Store or README must not break the run.
  for (const dir of readdirSync(root)
    .filter((d) => existsSync(`${root}${d}/template.json`))
    .sort()) {
    const { manifest, html, sources, problems } = await buildTemplate(`${root}${dir}`);
    builds.push({ dir, manifest, html, sources, problems });
  }
  return JSON.stringify(builds);
}

// FONT_FILES: the catalogue's WOFF2 files from fonts/, by repo path, base64, for `sf fonts push`.
function fontFiles() {
  const root = new URL('../../', import.meta.url).pathname;
  const paths = FONTS.flatMap((f) => f.files.map((x) => fontFilePath(f, x)));
  return JSON.stringify(Object.fromEntries(paths.map((p) => [p, readFileSync(`${root}${p}`).toString('base64')])));
}

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc', environment: 'dev' },
      miniflare: {
        bindings: {
          ADMIN_TOKEN: 'test-admin-token',
          TEST_MIGRATIONS: await readD1Migrations(new URL('../../packages/db/migrations', import.meta.url).pathname),
          TEMPLATE_BUILDS: await templateBuilds(),
          FONT_FILES: fontFiles(),
        },
      },
    })),
  ],
  test: { setupFiles: ['test/setup.ts'] },
});
