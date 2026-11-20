import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { buildTemplate } from '@signforge/cli/template';
// The fonts entry, not the index: Node loads this config, and the compiler's index uses extensionless imports.
import { FONTS, fontFilePath } from '@signforge/compiler/fonts';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { unstable_readConfig } from 'wrangler';

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

// TEMPLATE_CHECK: the check Worker (apps/template-check), replaced here by a stand-in in Node that
// passes every template except one whose bundle holds `sf-runtime-fail` (refused with a request) or
// `sf-runtime-garbage` (answered with a report the contract refuses), `sf-runtime-down` (a 503,
// as when its container cannot start or is over its limit), `sf-runtime-not-json` (a 200 whose body
// is not JSON) or `sf-runtime-cut` (a 200 whose body breaks off). Its runner image names the
// org path it was called on, as the check Worker picks the org's container by it. The real runner's
// tests are apps/template-check's.
async function templateCheck(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  const { manifest, html }: { manifest: { orientations: ('landscape' | 'portrait')[] }; html: string } = await request.json();
  if (html.includes('sf-runtime-garbage')) return Response.json({ ok: 'yes' });
  if (html.includes('sf-runtime-down')) return Response.json({ error: 'the check container did not start' }, { status: 503 });
  if (html.includes('sf-runtime-not-json')) return new Response('<html>Bad gateway</html>');
  if (html.includes('sf-runtime-cut')) {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"ok":'));
        c.error(new Error('the connection was lost'));
      },
    });
    return new Response(body, { headers: { 'content-type': 'application/json' } });
  }
  const problems = html.includes('sf-runtime-fail') ? ['requested https://example.com/leak (blocked)'] : [];
  return Response.json({
    ok: !problems.length,
    problems,
    runner: { image: `stand-in ${path}`, browser: 'Chromium 159' },
    renders: manifest.orientations.map((orientation) => ({
      orientation,
      viewport: orientation === 'landscape' ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 },
      readyMs: 80,
      frames: { count: 60, longestMs: 17 },
    })),
    cost: { startMs: 0, checkMs: 2800 },
  });
}

// RATE_LIMITS: each rate limit binding's limit and period in the `dev` environment, by name, for
// test/client.ts's `clockLimits`, which counts them on the tests' clock.
function rateLimits() {
  const { ratelimits } = unstable_readConfig({ config: new URL('wrangler.jsonc', import.meta.url).pathname, env: 'dev' }, { hideWarnings: true });
  return JSON.stringify(Object.fromEntries(ratelimits.map((r: { name: string; simple: { limit: number; period: number } }) => [r.name, r.simple])));
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
          // find_places's geocoder: a closed port, so no test reaches Open-Meteo.
          GEOCODING_URL: 'http://127.0.0.1:9/v1/search',
          // Every feed fetch (the poller's default guards, read_table): a closed port too.
          FEED_STUB_URL: 'http://127.0.0.1:9',
          TEST_MIGRATIONS: await readD1Migrations(new URL('../../packages/db/migrations', import.meta.url).pathname),
          TEMPLATE_BUILDS: await templateBuilds(),
          FONT_FILES: fontFiles(),
          RATE_LIMITS: rateLimits(),
        },
        serviceBindings: { TEMPLATE_CHECK: templateCheck },
      },
    })),
  ],
  // No module cache on disk: with it, a worker that starts after another gets every cached module inlined
  // into one message, over workerd's 32 MiB limit, and dies (docs/ci.md, "The API's workerd tests").
  test: { setupFiles: ['test/setup.ts'], fsModuleCache: false },
});
