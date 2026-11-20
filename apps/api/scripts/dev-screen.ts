/**
 * Create a test screen in the local D1 that `wrangler dev` uses, and print its credential.
 * For local work without pairing a screen (M3-08 pairs one). Local only: it never touches Cloudflare.
 *
 *   pnpm --filter @signforge/api dev:screen [--content <dir>] [--data <dir> | --sources <file>] [--org <id>] [--name <name>]
 *
 * --content  an `sf build` output directory (`dist/content`). Its manifest and files go into
 *            local R2 under the plan's layout, and the manifest becomes the screen's desired one.
 * --data     a directory of `<sourceId>.json` files, stored as the latest snapshot of each data
 *            source the manifest lists.
 * --sources  a project's `data-sources.json`: each source the manifest lists becomes a real one,
 *            its URL sealed, due now, so the poller (`wrangler dev --env dev --test-scheduled`, then
 *            GET /__scheduled, or the cron each minute) fetches it.
 * --org      the org to put the screen in (default `dev`), created in the `organization` table if
 *            it is not there yet. Any id matching ID_PATTERN works.
 *
 * The credential is the only thing written to stdout, once. Everything else goes to stderr.
 * Do not paste it anywhere: anyone holding it can fetch this screen's content.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { ScreenManifest } from '@signforge/contract';
import { seedOrganization, testScope } from '@signforge/db/testing';
import { getPlatformProxy } from 'wrangler';
import { feedUrlSealer } from '../src/data/cipher';
import { mintCredential } from '../src/device/credential';
import { manifestKey, orgBlobKey } from '../src/r2';

const { values: args } = parseArgs({
  options: {
    content: { type: 'string' },
    data: { type: 'string' },
    sources: { type: 'string' },
    org: { type: 'string', default: 'dev' },
    name: { type: 'string' },
  },
});
/** An entry of a project's `data-sources.json`, as `sf feeds` reads it. */
interface Feed {
  url: string;
  refreshS: number;
  format?: 'json' | 'ical' | 'rss';
  horizonDays?: number;
}

const log = (msg: string) => process.stderr.write(`${msg}\n`);
// Wrangler logs to stdout (e.g. "Using secrets defined in .dev.vars"); keep stdout for the credential alone.
console.log = console.error;

const manifest = args.content ? (JSON.parse(readFileSync(join(resolve(args.content), 'manifest.json'), 'utf8')) as ScreenManifest) : undefined;

const proxy = await getPlatformProxy<Env>({
  configPath: new URL('../wrangler.jsonc', import.meta.url).pathname,
  environment: 'dev',
  persist: true,
  remoteBindings: false,
});
try {
  const { DB, BLOBS } = proxy.env;
  // Since M3-09 a screen's org must exist in Better Auth's `organization` table. Make it if it is new.
  await seedOrganization(DB, args.org!);
  // Writes directly, as a test does: there is no tool call to stage them for.
  const org = testScope(DB, args.org!);

  const screen = await org.screens.insert({
    name: args.name ?? manifest?.screen.name ?? 'Test screen',
    timezone: manifest?.screen.timezone ?? 'UTC',
    locale: manifest?.screen.locale,
    orientation: manifest?.screen.orientation ?? 'landscape',
    displayHoursJson: manifest?.screen.displayHours ? JSON.stringify(manifest.screen.displayHours) : null,
  });
  const { credential, secretHash } = await mintCredential(screen.id);
  await org.screens.credentials.insert({ screenId: screen.id, secretHash });
  log(`screen ${screen.id} in org ${org.orgId}`);

  if (manifest && args.content) {
    const dir = resolve(args.content);
    for (const [sha, f] of Object.entries(manifest.files)) {
      await BLOBS.put(orgBlobKey(org.orgId, sha), readFileSync(join(dir, 'blobs', sha)), { httpMetadata: { contentType: f.type } });
    }
    await BLOBS.put(manifestKey(org.orgId, screen.id, manifest.id), readFileSync(join(dir, 'manifest.json')), {
      httpMetadata: { contentType: 'application/json' },
    });
    await org.screens.setDesiredManifest(screen.id, manifest.id);
    log(`manifest ${manifest.id.slice(0, 16)} and ${Object.keys(manifest.files).length} files loaded into local R2`);

    const feeds: Record<string, Feed> = args.sources ? JSON.parse(readFileSync(resolve(args.sources), 'utf8')) : {};
    // The manifest names its data sources; give each a row so its snapshot has somewhere to live.
    for (const [id, s] of Object.entries(manifest.dataSources)) {
      const feed = feeds[id];
      if (feed) {
        const urlEncrypted = await feedUrlSealer({ ENVIRONMENT: 'dev' }).seal({ orgId: org.orgId, id }, feed.url);
        const row = { name: id, format: feed.format ?? 'json', urlEncrypted, refreshS: feed.refreshS, horizonDays: feed.horizonDays ?? null, nextPollAt: 0 };
        if (await org.dataSources.get(id)) await org.dataSources.update(id, row);
        else await org.dataSources.insert({ id, ...row });
        log(`  data source ${id}: ${row.format}, polled every ${feed.refreshS} s`);
        continue;
      }
      if (!(await org.dataSources.get(id))) {
        // Data-source ids are per org (review fix 4), so the content's own ids always fit.
        await org.dataSources.insert({ id, name: id, format: 'json', urlEncrypted: '', refreshS: s.refreshS });
      }
      const file = args.data ? join(resolve(args.data), `${id}.json`) : undefined;
      if (file && existsSync(file)) {
        const dataJson = JSON.stringify(JSON.parse(readFileSync(file, 'utf8')));
        const version = createHash('sha256').update(dataJson).digest('hex');
        const now = Date.now();
        await org.dataSources.putSnapshot(id, { version, fetchedAt: now, checkedAt: now, dataJson });
        log(`  data source ${id}: snapshot loaded`);
      } else log(`  data source ${id}: no snapshot (pass --data <dir> with ${id}.json)`);
    }
  }

  process.stdout.write(`${credential}\n`);
} finally {
  await proxy.dispose();
}
