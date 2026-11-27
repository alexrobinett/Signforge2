#!/usr/bin/env tsx
/**
 * The New spot dialog's template thumbnails: every base template in `templates/`, drawn by the real
 * player with its own defaults, saved as `apps/cms/public/template-thumbnails/<id>.webp` (480×270), and the
 * versions they were drawn from in `apps/cms/src/lib/template-thumbnails.json`. A CMS test fails when
 * a template's version moves past its thumbnail's, so a new version is drawn again with it.
 *
 *   pnpm build:player && tsx scripts/template-thumbnails.ts --chrome <path to Chromium>
 *
 * Image fields get one placeholder photo (an SVG drawn here), and fields with no default a wireframe's
 * stand-in (`stand`), so a thumbnail shows the template's layout rather than anyone's content.
 * The player draws them at a fixed time (`CLOCK`), so a clock, a countdown or an agenda draws the
 * same on every run, and a run that changes no template changes no file.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: { chrome: { type: 'string', default: process.env.CHROME } } });
if (!args.chrome) {
  console.error('usage: template-thumbnails --chrome <path to Chromium>');
  process.exit(2);
}
const root = resolve(import.meta.dirname, '..');
const project = mkdtempSync(join(tmpdir(), 'sf-thumbs-'));
for (const dir of ['spots', 'playlists', 'media']) mkdirSync(join(project, dir));

// Warm shapes on a dark ground: reads as a photo at thumbnail size without being one.
writeFileSync(
  join(project, 'media/photo.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="#3a2a22"/><circle cx="1150" cy="380" r="330" fill="#c2703d"/><circle cx="520" cy="640" r="260" fill="#7d8f5a"/><rect y="700" width="1600" height="200" fill="#25201c"/></svg>`,
);

interface Field {
  type: string;
  label: string;
  default?: unknown;
  item?: Record<string, Field>;
}
/** A field with no default, as a wireframe would fill it: its label for text, a fixed day for a date, three rows for a list (an empty one too). */
const stand = (f: Field): unknown =>
  f.type === 'date'
    ? '2026-12-24'
    : f.type === 'datetime'
      ? '2026-12-24T18:00'
      : f.type === 'list'
        ? Array.from({ length: 3 }, () => Object.fromEntries(Object.entries(f.item ?? {}).map(([n, sub]) => [n, sub.default ?? stand(sub)])))
        : f.type === 'text'
          ? f.label
          : undefined;
/** When the player draws every thumbnail: a weekday morning, three days before the stand-in date. */
const CLOCK = '2026-12-21T09:00:00Z';
/** Data a label cannot stand in for: an agenda shows only events still to come today or soon. */
const hence = (hours: number) => new Date(Date.parse(CLOCK) + hours * 3_600_000).toISOString();
const OVERRIDES: Record<string, Record<string, unknown>> = {
  agenda: { events: ['Team stand-up', 'Design review', 'All hands'].map((title, i) => ({ title, start: hence(i + 1), end: hence(i + 1.75) })) },
};
const templates = readdirSync(join(root, 'templates'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d): { id: string; version: string; fields: Record<string, Field> } =>
    JSON.parse(readFileSync(join(root, 'templates', d.name, 'template.json'), 'utf8')),
  )
  .sort((a, b) => a.id.localeCompare(b.id));

for (const t of templates) {
  const fields = Object.entries(t.fields);
  // An empty list (a menu's items, a feed's stories before the feed is read) shows nothing of the layout.
  const unset = (f: Field) => f.default === undefined || (Array.isArray(f.default) && f.default.length === 0);
  const data = {
    ...Object.fromEntries(fields.filter(([, f]) => unset(f) && stand(f) !== undefined).map(([name, f]) => [name, stand(f)])),
    ...OVERRIDES[t.id],
  };
  const assets = Object.fromEntries(fields.filter(([, f]) => f.type === 'image').map(([name]) => [name, 'photo.svg']));
  writeFileSync(join(project, 'spots', `${t.id}.json`), JSON.stringify({ name: t.id, kind: 'template', template: t.id, data, assets }));
}
writeFileSync(join(project, 'screen.json'), JSON.stringify({ id: 'thumbnails', name: 'Thumbnails', timezone: 'UTC', orientation: 'landscape' }));
writeFileSync(join(project, 'playlists/all.json'), JSON.stringify({ name: 'All', transition: { type: 'cut' }, items: templates.map((t) => t.id) }));
writeFileSync(join(project, 'schedule.json'), JSON.stringify({ defaultPlaylist: 'all', entries: [] }));

const run = (script: string, argv: string[]) => {
  const r = spawnSync('pnpm', ['exec', 'tsx', script, ...argv], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${script} failed`);
};
run('packages/cli/src/sf.ts', ['build', project, '--out', join(project, 'out')]);
run('scripts/spot-shots.ts', [
  '--content',
  join(project, 'out'),
  '--out',
  join(project, 'shots'),
  '--chrome',
  args.chrome,
  '--sizes',
  '1920x1080',
  '--scale',
  '0.25',
  '--format',
  'webp',
  '--clock',
  CLOCK,
]);

const outDir = join(root, 'apps/cms/public/template-thumbnails');
mkdirSync(outDir, { recursive: true });
for (const t of templates) copyFileSync(join(project, 'shots', `${t.id}-1920x1080-a.webp`), join(outDir, `${t.id}.webp`));
writeFileSync(
  join(root, 'apps/cms/src/lib/template-thumbnails.json'),
  `${JSON.stringify(Object.fromEntries(templates.map((t) => [t.id, t.version])), null, 2)}\n`,
);
console.log(`drew ${templates.length} thumbnails into ${outDir}`);
