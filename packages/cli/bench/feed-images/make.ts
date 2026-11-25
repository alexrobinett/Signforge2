/**
 * Content for the Pi bench of feed images (#196, spike/pi-perf/RESULTS.md): one screen's static
 * content, as `sf build` writes it, plus the snapshots and feed images a sync would bring.
 *
 *   tsx packages/cli/bench/feed-images/make.ts <out-dir> <landscape|portrait>
 *
 * Spots `text` and `photos` play the bench template (template/) over ten stories: `text` with no
 * images, `photos` with each story's photo, 1920x1080 and its 480x270 thumbnail (20 JPEGs, made
 * here from a fixed seed, so every run measures the same bytes). Also `data/news.json`, the same
 * ten stories for the stress set's `news` spot. `serve.py` serves the result beside the player.
 *
 * The snapshots are checked as of the moment it runs: a player shows none checked more than a day
 * before (`SNAPSHOT_STALE_MS`), so make the content on the day you measure.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MANIFEST_SCHEMA, MIN_REFRESH_S, manifestIdInput, templateKey, type DataSnapshot, type ScreenManifest } from '@signforge/contract';
import sharp from 'sharp';
import { buildTemplate } from '@signforge/template-build';

const [out, orientation] = process.argv.slice(2);
if (!out || (orientation !== 'landscape' && orientation !== 'portrait')) {
  console.error('usage: tsx packages/cli/bench/feed-images/make.ts <out-dir> <landscape|portrait>');
  process.exit(1);
}
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
mkdirSync(join(out, 'blobs'), { recursive: true });
mkdirSync(join(out, 'data'), { recursive: true });
const types: Record<string, string> = {};
let imageBytes = 0;
function put(body: Buffer, type: string): string {
  const sha = sha256(body);
  writeFileSync(join(out, 'blobs', sha), body);
  types[sha] = type;
  if (type === 'image/jpeg') imageBytes += body.byteLength;
  return sha;
}

// A photo's worth of detail: smooth colour at a sixteenth of the size, scaled up, with grain.
let seed = 196;
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
};
async function photo(w: number, h: number): Promise<Buffer> {
  const [sw, sh] = [Math.ceil(w / 16), Math.ceil(h / 16)];
  const small = Buffer.alloc(sw * sh * 3, 0).map(() => Math.floor(random() * 256));
  const colour = await sharp(small, { raw: { width: sw, height: sh, channels: 3 } })
    .resize(w, h, { kernel: 'cubic' })
    .raw()
    .toBuffer();
  const grain = colour.map((v) => Math.max(0, Math.min(255, v + Math.floor((random() - 0.5) * 28))));
  return sharp(grain, { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality: 82 })
    .toBuffer();
}

const at = '2026-11-23T00:00:00Z';
const text = Array.from({ length: 10 }, (_, i) => ({
  title: `Story ${i + 1}: a headline about as long as a feed's, so it wraps onto a second line`,
  published: at,
  source: 'Bench',
}));
const photos = [];
for (const story of text)
  photos.push({ ...story, image: { file: put(await photo(1920, 1080), 'image/jpeg'), thumb: put(await photo(480, 270), 'image/jpeg') } });
const snapshot = (id: string, items: unknown[]): DataSnapshot => ({
  id,
  version: 1,
  fetchedAt: at,
  checkedAt: new Date().toISOString(),
  data: { title: 'Bench', language: 'en', items },
});
writeFileSync(join(out, 'data/text.json'), JSON.stringify(snapshot('text', text)));
writeFileSync(join(out, 'data/photos.json'), JSON.stringify(snapshot('photos', photos)));
writeFileSync(join(out, 'data/news.json'), JSON.stringify(snapshot('news', text)));

const built = await buildTemplate(resolve(import.meta.dirname, 'template'));
const html = put(Buffer.from(built.html), 'text/html');
const key = templateKey(built.manifest);
const spot = (id: string) => ({
  id,
  name: id,
  kind: 'template' as const,
  template: key,
  durationMs: 6000,
  data: { items: [] },
  assets: {},
  bindings: { items: { source: id, path: 'items' } },
});
const body: Omit<ScreenManifest, 'id'> = {
  schema: MANIFEST_SCHEMA,
  generatedAt: at,
  screen: { id: 'feed-bench', name: 'Feed image bench', timezone: 'UTC', orientation },
  files: { [html]: { size: Buffer.byteLength(built.html), type: 'text/html' } },
  templates: { [key]: { manifest: built.manifest, html } },
  spots: { text: spot('text'), photos: spot('photos') },
  playlists: { main: { id: 'main', name: 'Main', transition: { type: 'cut' }, items: [{ spot: 'text' }, { spot: 'photos' }] } },
  dataSources: { text: { id: 'text', refreshS: MIN_REFRESH_S }, photos: { id: 'photos', refreshS: MIN_REFRESH_S } },
  schedule: [],
  defaultPlaylist: 'main',
};
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ ...body, id: sha256(manifestIdInput(body)) }));
writeFileSync(join(out, 'types.json'), JSON.stringify(types));
console.log(`${out}: ${orientation}, ${photos.length * 2} feed images, ${Math.round(imageBytes / 1000)} kB`);
