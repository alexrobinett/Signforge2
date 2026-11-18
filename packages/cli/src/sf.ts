#!/usr/bin/env tsx
/**
 * sf: the local publisher. Stands in for the backend until Milestone 3.
 *
 *   sf build <project-dir> --out <dir>
 *   sf push <out-dir> --screen <id> --api <url>
 *   sf template push <template-dir> --api <url> [--org <id>] [--approve]
 *   sf template seed [templates-dir] --api <url>
 *   sf fonts push --api <url>
 *
 * Reads a content project (screen, spots, playlists, schedule, media), builds every template
 * it uses into one self-contained HTML file, checks it against the contract, and writes an
 * immutable screen manifest plus content-addressed blobs:
 *
 *   <out>/manifest.json
 *   <out>/blobs/<sha256>
 *
 * `sf push` uploads such a directory to the API and makes it a screen's desired manifest. It is
 * temporary, until the CMS publishes: it calls the `/admin` routes with the `ADMIN_TOKEN` deploy
 * secret, read from the `SF_ADMIN_TOKEN` environment variable; the API publishes through its tool
 * registry and audits it as `sf-push`. See ./push.ts.
 *
 * `sf template push` builds one template, uploads its bundle and the author's sources, and
 * registers the version; the API repeats the build's checks (./template-push.ts). Without `--org`
 * it is a base template every org can use. `sf template seed` pushes every template in
 * `templates/` as an approved base template, and the brand font catalogue (`fonts/`, as
 * `sf fonts push` does), and is run on each deploy.
 *
 * A project may have a `brand.json`: the screen's brand kit, as the CMS would publish it, with
 * fonts named by catalogue id and logos as media paths:
 *   { "colors": { ... all eight ... }, "shape": "soft",
 *     "fonts": { "display": "base/oswald", "body": "base/inter" }, "logo": { "onDark": "logo.svg" } }
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import sharp from 'sharp';
import {
  SCREEN_BOX,
  VIDEO_SPEC,
  coverSize,
  validateBrandKit,
  templateKey,
  type ScreenBox,
  type Binding,
  type BrandColors,
  type BrandFont,
  type BrandKit,
  type BrandShape,
  type CalendarFeed,
  type DataSnapshot,
  type DataSource,
  type NewsFeed,
  type Playlist,
  type ScreenManifest,
  type Spot,
  type Transition,
} from '@signforge/contract';
import { FeedError, normaliseFeed } from '@signforge/feeds';
import { compileScreen, fontById, fontFilePath, onColor, spotProblems, type CompileInput, type TargetedEntry } from '@signforge/compiler';
import { push, PushError } from './push';
import { buildTemplate, type BuiltTemplate } from './template';
import { pushFonts, pushTemplate, TemplatePushError } from './template-push';

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.webm': 'video/webm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
};

/**
 * Scale a raster image down to the smallest size that still covers the screen, so the device
 * never decodes or uploads more pixels than it can show. A 4K photo is a quarter of the work
 * at 1080p. SVG and images already small enough pass through untouched.
 */
async function fitImage(data: Buffer, type: string, box: ScreenBox): Promise<{ data: Buffer; note?: string }> {
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(type)) return { data };
  const img = sharp(data, { failOn: 'error' }).rotate();
  const meta = await img.metadata();
  const w = meta.autoOrient?.width ?? meta.width ?? 0;
  const h = meta.autoOrient?.height ?? meta.height ?? 0;
  const size = coverSize(w, h, box);
  if (!size.scaled) return { data };
  const resized = img.resize({ width: size.width, height: size.height });
  const out =
    type === 'image/png'
      ? await resized.png({ compressionLevel: 9 }).toBuffer()
      : type === 'image/webp'
        ? await resized.webp({ quality: 85 }).toBuffer()
        : type === 'image/avif'
          ? await resized.avif({ quality: 60 }).toBuffer()
          : await resized.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  return { data: out, note: `${w}x${h} -> ${size.width}x${size.height}, ${(data.length / 1024).toFixed(0)} -> ${(out.length / 1024).toFixed(0)} kB` };
}

/** Check a video against the screen profile with ffprobe. Returns problems; skipped with a warning only if ffprobe is not installed. */
function checkVideo(path: string): string[] {
  let out: string;
  try {
    out = execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=codec_name,profile,pix_fmt,level,field_order,width,height,avg_frame_rate,r_frame_rate,bit_rate:format=bit_rate',
        '-of',
        'json',
        path,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.warn(`  warning: ffprobe not found; ${basename(path)} was not checked against the video spec`);
      return [];
    }
    return [
      `ffprobe could not read the file: ${
        String((err as { stderr?: string }).stderr ?? err)
          .trim()
          .split('\n')[0]
      }`,
    ];
  }
  type Stream = {
    codec_name: string;
    profile?: string;
    pix_fmt?: string;
    level?: number;
    field_order?: string;
    width: number;
    height: number;
    avg_frame_rate: string;
    r_frame_rate: string;
    bit_rate?: string;
  };
  const probe = JSON.parse(out) as { streams: Stream[]; format?: { bit_rate?: string } };
  const v = probe.streams[0];
  if (!v) return ['no video stream'];
  const rate = (r: string) => {
    const [num, den] = r.split('/').map(Number);
    return den ? (num ?? 0) / den : 0;
  };
  const fps = rate(v.avg_frame_rate) || rate(v.r_frame_rate);
  // The stream's own bit rate when the container records it, the whole file's otherwise.
  const bitrate = Number(v.bit_rate) || Number(probe.format?.bit_rate);
  const long = Math.max(v.width, v.height),
    short = Math.min(v.width, v.height);
  const problems: string[] = [];
  if (v.codec_name !== VIDEO_SPEC.codec) problems.push(`codec is ${v.codec_name}; screens need ${VIDEO_SPEC.codec}`);
  if (!(VIDEO_SPEC.pixelFormats as readonly string[]).includes(v.pix_fmt ?? ''))
    problems.push(`pixel format is ${v.pix_fmt}; screens need 8-bit 4:2:0 (yuv420p)`);
  if (v.profile && !(VIDEO_SPEC.profiles as readonly string[]).includes(v.profile))
    problems.push(`H.264 profile ${v.profile} is not supported; use High or Main`);
  if (v.level !== undefined && v.level > VIDEO_SPEC.maxLevel) problems.push(`H.264 level ${v.level / 10} is above ${VIDEO_SPEC.maxLevel / 10}`);
  if (v.field_order && !['progressive', 'unknown'].includes(v.field_order)) problems.push('video is interlaced; screens need progressive');
  if (long > VIDEO_SPEC.maxWidth || short > VIDEO_SPEC.maxHeight)
    problems.push(`${v.width}x${v.height} is larger than ${VIDEO_SPEC.maxWidth}x${VIDEO_SPEC.maxHeight}`);
  if (!(fps > 0)) problems.push('frame rate could not be read');
  else if (fps > VIDEO_SPEC.maxFps + 0.5) problems.push(`${fps.toFixed(0)} fps is above ${VIDEO_SPEC.maxFps}`);
  if (!(bitrate > 0)) problems.push('bit rate could not be read');
  else if (bitrate > VIDEO_SPEC.maxBitrate) problems.push(`${(bitrate / 1e6).toFixed(1)} Mbit/s is above ${VIDEO_SPEC.maxBitrate / 1e6}`);
  return problems;
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const jsonFiles = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
    : [];

class Problems {
  list: string[] = [];
  add(where: string, messages: string[]) {
    for (const m of messages) this.list.push(`${where}: ${m}`);
  }
}

interface SpotFile {
  name: string;
  kind: Spot['kind'];
  template?: string;
  data?: Record<string, unknown>;
  assets?: Record<string, string>;
  bindings?: Record<string, Binding>;
  file?: string;
  fit?: 'cover' | 'contain';
  url?: string;
  durationMs?: number;
}

/**
 * A local project describes one screen. Its schedule entries may name a `targetId`; one that does
 * not applies to this screen, and the screen belongs to the groups listed in `screen.json`
 * (`groups`, default `["local"]`).
 */
async function buildProject(projectDir: string, outDir: string, templatesDir: string): Promise<void> {
  const problems = new Problems();
  const { groups = ['local'], ...screen } = readJson<ScreenManifest['screen'] & { groups?: string[] }>(join(projectDir, 'screen.json'));
  const blobs = new Map<string, { data: Buffer; type: string }>();
  const addBlob = (data: Buffer, type: string) => {
    const hash = sha256(data);
    blobs.set(hash, { data, type });
    return hash;
  };
  const fitted = new Map<string, Buffer>();
  const addMedia = async (rel: string, where: string): Promise<string> => {
    const path = join(projectDir, 'media', rel);
    if (!existsSync(path)) {
      problems.add(where, [`media file "${rel}" not found`]);
      return '';
    }
    const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
    if (type.startsWith('video/') && !fitted.has(rel))
      problems.add(
        where,
        checkVideo(path).map((p) => `${rel}: ${p}`),
      );
    if (!fitted.has(rel)) {
      const { data, note } = await fitImage(readFileSync(path), type, SCREEN_BOX[screen.orientation]);
      if (note) console.log(`  image ${rel}  ${note}`);
      fitted.set(rel, data);
    }
    return addBlob(fitted.get(rel)!, type);
  };

  // What the server would hold after upload: built templates and media as hashed files.
  // Checking spots against their templates and assembling the manifest is the compiler's job.
  console.log(`Building ${projectDir}`);
  const templates: CompileInput['templates'] = {};
  const built = new Map<string, BuiltTemplate>();
  const spots: Spot[] = [];
  for (const f of jsonFiles(join(projectDir, 'spots'))) {
    const id = basename(f, '.json');
    const where = `spot ${id}`;
    const s = readJson<SpotFile>(join(projectDir, 'spots', f));
    if (s.kind === 'template') {
      const tdir = join(templatesDir, s.template ?? '');
      if (!s.template || !existsSync(join(tdir, 'template.json'))) {
        problems.add(where, [`template "${s.template}" not found in ${templatesDir}`]);
        continue;
      }
      if (!built.has(s.template)) {
        const b = await buildTemplate(tdir);
        problems.add(`template ${s.template}`, b.problems);
        built.set(s.template, b);
      }
      const t = built.get(s.template)!;
      const key = templateKey(t.manifest);
      templates[key] = { manifest: t.manifest, html: addBlob(Buffer.from(t.html), 'text/html') };
      const assets: Record<string, string> = {};
      for (const [field, rel] of Object.entries(s.assets ?? {})) assets[field] = await addMedia(rel, where);
      const durationMs = s.durationMs ?? t.manifest.duration.defaultMs;
      spots.push({
        id,
        name: s.name,
        kind: 'template',
        template: key,
        data: s.data ?? {},
        assets,
        durationMs,
        ...(s.bindings ? { bindings: s.bindings } : {}),
      });
    } else if (s.kind === 'image' || s.kind === 'video') {
      if (!s.file) problems.add(where, ['file is required']);
      if (!s.durationMs) problems.add(where, ['durationMs is required']);
      spots.push({ id, name: s.name, kind: s.kind, file: await addMedia(s.file ?? '', where), fit: s.fit ?? 'cover', durationMs: s.durationMs ?? 0 });
    } else if (s.kind === 'url') {
      spots.push({ id, name: s.name, kind: 'url', url: s.url ?? '', durationMs: s.durationMs ?? 0 });
    } else {
      problems.add(where, [`unknown kind "${String(s.kind)}"`]);
    }
  }

  const playlists: Playlist[] = jsonFiles(join(projectDir, 'playlists')).map((f) => {
    const id = basename(f, '.json');
    const p = readJson<{ name: string; transition?: Transition; items: string[] }>(join(projectDir, 'playlists', f));
    return { id, name: p.name, transition: p.transition ?? { type: 'cut' }, items: p.items.map((spot) => ({ spot })) };
  });

  // Data sources. The feed URL stays on the publishing side; screens only learn the id and refresh rate.
  const sourcesPath = join(projectDir, 'data-sources.json');
  const sourceDefs = existsSync(sourcesPath) ? readJson<Record<string, { url: string; refreshS: number; format?: 'json' | 'ical' | 'rss' }>>(sourcesPath) : {};
  const dataSources: DataSource[] = Object.entries(sourceDefs).map(([id, d]) => ({ id, refreshS: d.refreshS }));

  const sched = readJson<{ defaultPlaylist: string; entries?: TargetedEntry[] }>(join(projectDir, 'schedule.json'));
  const schedule = (sched.entries ?? []).map((e) => ({
    ...e,
    targetId: e.targetId ?? (e.target === 'screen' ? screen.id : e.target === 'group' ? groups[0] : undefined),
  }));
  for (const e of schedule) {
    const elsewhere = (e.target === 'group' && !groups.includes(e.targetId ?? '')) || (e.target === 'screen' && e.targetId !== screen.id);
    if (elsewhere) console.warn(`  note: schedule entry ${e.id} targets ${e.target} "${e.targetId}", which is not this screen; it is left out`);
  }

  const brand = await readBrand(projectDir, problems, addBlob, addMedia);

  const files: CompileInput['files'] = {};
  for (const [hash, b] of blobs) files[hash] = { size: b.data.length, type: b.type };

  const result = await compileScreen(
    {
      screen,
      groups,
      templates,
      files,
      spots,
      playlists,
      dataSources,
      schedule,
      defaultPlaylist: sched.defaultPlaylist,
      ...(brand ? { brand: { kits: { [brand.id]: brand }, groups: {}, default: brand.id } } : {}),
    },
    { hash: (text) => sha256(text), now: new Date() },
  );
  problems.list.push(...result.problems);
  // The compiler checks only what this screen plays. A local project has no drafts: every spot
  // in it is being published, so one this screen does not reach is checked too.
  const compiled = new Set(Object.keys(result.manifest?.spots ?? {}));
  for (const s of spots)
    if (!compiled.has(s.id) && !result.problems.some((p) => p.startsWith(`spot ${s.id}:`))) problems.add(`spot ${s.id}`, spotProblems(s, templates));
  const manifest = result.manifest;
  if (problems.list.length || !manifest) {
    console.error(`\n${problems.list.length} problem(s):`);
    for (const p of problems.list) console.error(`  - ${p}`);
    process.exit(1);
  }

  mkdirSync(join(outDir, 'blobs'), { recursive: true });
  for (const hash of Object.keys(manifest.files)) writeFileSync(join(outDir, 'blobs', hash), blobs.get(hash)!.data);
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  // For the stand-in fetcher on the device. With a backend this list never leaves the server.
  writeFileSync(join(outDir, 'data-sources.json'), JSON.stringify(sourceDefs, null, 2));
  const total = Object.values(manifest.files).reduce((n, f) => n + f.size, 0);
  console.log(
    `  manifest ${manifest.id.slice(0, 16)}: ${Object.keys(manifest.spots).length} spots, ${Object.keys(manifest.playlists).length} playlists, ${Object.keys(manifest.files).length} files, ${(total / 1024).toFixed(0)} kB`,
  );
  console.log(`  wrote ${outDir}`);
}

/**
 * The project's `brand.json` as the brand kit the screen gets, or undefined without one. Fonts are
 * catalogue ids, read from the repo's fonts/; logos are media paths. `onPrimary` and `onAccent`
 * may be left out, and are derived for contrast as the CMS does.
 */
async function readBrand(
  projectDir: string,
  problems: Problems,
  addBlob: (data: Buffer, type: string) => string,
  addMedia: (rel: string, where: string) => Promise<string>,
): Promise<BrandKit | undefined> {
  const path = join(projectDir, 'brand.json');
  if (!existsSync(path)) return undefined;
  const b = readJson<{
    colors: Omit<BrandColors, 'onPrimary' | 'onAccent'> & Partial<Pick<BrandColors, 'onPrimary' | 'onAccent'>>;
    shape?: BrandShape;
    fonts?: { display?: string; body?: string };
    logo?: { onDark: string; onLight?: string };
  }>(path);
  const repo = resolve(import.meta.dirname, '../../..');
  const font = (id: string | undefined, role: string): BrandFont | undefined => {
    if (!id) return undefined;
    const f = fontById(id);
    if (!f) {
      problems.add('brand', [`${role} font "${id}" is not in the catalogue`]);
      return undefined;
    }
    for (const x of f.files) addBlob(readFileSync(join(repo, fontFilePath(f, x))), 'font/woff2');
    return { id: f.id, family: f.family, files: f.files.map(({ weight, style, file }) => ({ weight, style, file })) };
  };
  const display = font(b.fonts?.display, 'display');
  const body = font(b.fonts?.body, 'body');
  const colors: BrandColors = {
    ...b.colors,
    onPrimary: b.colors.onPrimary ?? onColor(b.colors.primary),
    onAccent: b.colors.onAccent ?? onColor(b.colors.accent),
  };
  const kit: BrandKit = { id: 'local', colors, shape: b.shape ?? 'soft', fonts: { ...(display ? { display } : {}), ...(body ? { body } : {}) } };
  if (b.logo) {
    const onDark = await addMedia(b.logo.onDark, 'brand');
    const onLight = b.logo.onLight ? await addMedia(b.logo.onLight, 'brand') : undefined;
    kit.logo = { onDark, ...(onLight ? { onLight } : {}) };
  }
  problems.add('brand', validateBrandKit(kit));
  return kit;
}

/**
 * Fetch every data source a project lists, convert it the way the server will, and write the
 * snapshots the player reads (`<out>/<id>.json`). For testing templates against live data until
 * the server's poller (M3-23) exists. Failures are reported per source; the others still write.
 */
async function fetchFeeds(projectDir: string, outDir: string): Promise<void> {
  const sources = readJson<Record<string, { url: string; format?: 'json' | 'ical' | 'rss'; horizonDays?: number }>>(join(projectDir, 'data-sources.json'));
  mkdirSync(outDir, { recursive: true });
  const now = new Date();
  let failed = 0;
  for (const [id, src] of Object.entries(sources)) {
    try {
      const res = await fetch(src.url, { headers: { 'user-agent': 'signforge-dev' }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      const data =
        src.format === 'ical'
          ? normaliseFeed('ical', body, { now, ...(src.horizonDays ? { horizonDays: src.horizonDays } : {}) })
          : src.format === 'rss'
            ? normaliseFeed('rss', body)
            : JSON.parse(body);
      const snapshot: DataSnapshot = { id, version: now.getTime(), fetchedAt: now.toISOString(), data };
      writeFileSync(join(outDir, `${id}.json`), JSON.stringify(snapshot));
      const count =
        src.format === 'ical' ? `${(data as CalendarFeed).events.length} events` : src.format === 'rss' ? `${(data as NewsFeed).items.length} items` : 'json';
      console.log(`  ${id}: ${count}`);
    } catch (err) {
      failed++;
      console.error(`  ${id}: failed (${err instanceof FeedError ? err.code : err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (failed) process.exitCode = 1;
}

const [cmd, dirArg, ...rest] = process.argv.slice(2);

/** The API's `ADMIN_TOKEN`, from `SF_ADMIN_TOKEN`. */
function adminToken(command: string): string {
  const token = process.env.SF_ADMIN_TOKEN;
  if (!token) {
    console.error(`${command}: set SF_ADMIN_TOKEN to the API's ADMIN_TOKEN (locally, the value in apps/api/.dev.vars)`);
    process.exit(2);
  }
  return token;
}
/** `sf fonts push`: the catalogue's files from the repo's fonts/ to the API's sys/b/. */
async function uploadFonts(token: string): Promise<void> {
  const root = resolve(import.meta.dirname, '../../..');
  console.log('Pushing the brand font catalogue');
  try {
    await pushFonts({ api: flag('api')!, token, read: (path) => readFileSync(join(root, path)), log: (l) => console.log(`  ${l}`) });
  } catch (err) {
    if (!(err instanceof TemplatePushError)) throw err;
    console.error(`  failed: ${err.message}`);
    process.exit(1);
  }
}

const USAGE =
  'usage:\n  sf build <project-dir> [--out <dir>] [--templates <dir>]\n  sf feeds <project-dir> [--out <dir>]   (live data snapshots, default dist/content/data)\n  sf push <out-dir> --screen <id> --api <url>   (token in SF_ADMIN_TOKEN)\n  sf template push <template-dir> --api <url> [--org <id>] [--approve]   (base template unless --org)\n  sf template seed [templates-dir] --api <url>   (every template, as approved base templates, and the brand fonts)\n  sf fonts push --api <url>   (the brand font catalogue, to sys/b/)';
const flag = (name: string, fallback?: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1]! : fallback;
};
if (cmd === 'build' && dirArg) {
  await buildProject(resolve(dirArg), resolve(flag('out', 'dist/content')!), resolve(flag('templates', 'templates')!));
} else if (cmd === 'feeds' && dirArg) {
  console.log(`Fetching feeds for ${dirArg}`);
  await fetchFeeds(resolve(dirArg), resolve(flag('out', 'dist/content/data')!));
} else if (cmd === 'push' && dirArg && flag('screen') && flag('api')) {
  const token = adminToken('sf push');
  const dir = resolve(dirArg);
  const manifestText = readFileSync(join(dir, 'manifest.json'), 'utf8');
  const screen = flag('screen')!;
  const built = JSON.parse(manifestText) as ScreenManifest;
  if (built.screen.id !== screen) console.log(`  note: the build is for screen "${built.screen.id}"; pushing it to ${screen} as it is`);
  console.log(`Pushing ${dir} to ${screen}`);
  try {
    const r = await push({
      api: flag('api')!,
      screen,
      token,
      manifestText,
      readBlob: (sha) => readFileSync(join(dir, 'blobs', sha)),
      log: (l) => console.log(`  ${l}`),
    });
    console.log(`  done: ${r.uploaded} of ${r.files} files uploaded (${(r.uploadedBytes / 1024).toFixed(0)} kB)`);
  } catch (err) {
    if (!(err instanceof PushError)) throw err;
    console.error(`sf push failed: ${err.message}`);
    process.exit(1);
  }
} else if (cmd === 'fonts' && dirArg === 'push' && flag('api')) {
  await uploadFonts(adminToken('sf fonts push'));
} else if (cmd === 'template' && (dirArg === 'push' || dirArg === 'seed') && flag('api')) {
  const token = adminToken(`sf template ${dirArg}`);
  const org = flag('org');
  // seed: every template in the directory, as approved base templates. push: one, as a draft unless --approve.
  const target = rest[0] && !rest[0].startsWith('--') ? resolve(rest[0]) : dirArg === 'seed' ? resolve('templates') : undefined;
  if (!target || (dirArg === 'seed' && org)) {
    console.error(USAGE);
    process.exit(2);
  }
  const dirs =
    dirArg === 'seed'
      ? readdirSync(target)
          .map((d) => join(target, d))
          .filter((d) => existsSync(join(d, 'template.json')))
          .sort()
      : [target];
  const owner = org ? { org } : ('base' as const);
  if (dirArg === 'seed') await uploadFonts(token);
  let failed = 0;
  for (const dir of dirs) {
    console.log(`Pushing ${basename(dir)} to ${org ? `org ${org}` : 'base templates'}`);
    const built = await buildTemplate(dir);
    if (built.problems.length) {
      failed++;
      for (const p of built.problems) console.error(`  - ${p}`);
      continue;
    }
    try {
      await pushTemplate({
        api: flag('api')!,
        token,
        owner,
        ...built,
        approve: dirArg === 'seed' || rest.includes('--approve'),
        log: (l) => console.log(`  ${l}`),
      });
    } catch (err) {
      if (!(err instanceof TemplatePushError)) throw err;
      failed++;
      console.error(`  failed: ${err.message}`);
    }
  }
  if (failed) {
    console.error(`${failed} of ${dirs.length} template(s) not pushed`);
    process.exit(1);
  }
} else {
  console.error(USAGE);
  process.exit(2);
}
