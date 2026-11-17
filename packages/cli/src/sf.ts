#!/usr/bin/env tsx
/**
 * sf: the local publisher. Stands in for the backend until Milestone 3.
 *
 *   sf build <project-dir> --out <dir>
 *
 * Reads a content project (screen, spots, playlists, schedule, media), builds every template
 * it uses into one self-contained HTML file, checks it against the contract, and writes an
 * immutable screen manifest plus content-addressed blobs:
 *
 *   <out>/manifest.json
 *   <out>/blobs/<sha256>
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import sharp from 'sharp';
import {
  FORBIDDEN_CSS, FORBIDDEN_TEMPLATE_CODE, PROTOCOL_VERSION, TEMPLATE_BUDGET, VIDEO_SPEC, templateKey, validateTemplateManifest,
  type Binding, type DataSource, type Playlist, type ScreenManifest, type Spot, type TemplateManifest, type Transition,
} from '@signforge/contract';
import { compileScreen, type CompileInput, type TargetedEntry } from '@signforge/compiler';

const MIME: Record<string, string> = {
  '.html': 'text/html', '.webm': 'video/webm', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.mp4': 'video/mp4',
};

/** The largest frame a screen of each orientation draws. Images are never shipped bigger than this. */
const SCREEN_BOX = { landscape: { w: 1920, h: 1080 }, portrait: { w: 1080, h: 1920 } } as const;

/**
 * Scale a raster image down to the smallest size that still covers the screen, so the device
 * never decodes or uploads more pixels than it can show. A 4K photo is a quarter of the work
 * at 1080p. SVG and images already small enough pass through untouched.
 */
async function fitImage(data: Buffer, type: string, box: { w: number; h: number }): Promise<{ data: Buffer; note?: string }> {
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(type)) return { data };
  const img = sharp(data, { failOn: 'error' }).rotate();
  const meta = await img.metadata();
  const w = meta.autoOrient?.width ?? meta.width ?? 0;
  const h = meta.autoOrient?.height ?? meta.height ?? 0;
  const scale = Math.min(1, Math.max(box.w / w, box.h / h));
  if (scale >= 1) return { data };
  const size = { width: Math.round(w * scale), height: Math.round(h * scale) };
  const resized = img.resize(size);
  const out = type === 'image/png' ? await resized.png({ compressionLevel: 9 }).toBuffer()
    : type === 'image/webp' ? await resized.webp({ quality: 85 }).toBuffer()
    : type === 'image/avif' ? await resized.avif({ quality: 60 }).toBuffer()
    : await resized.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  return { data: out, note: `${w}x${h} -> ${size.width}x${size.height}, ${(data.length / 1024).toFixed(0)} -> ${(out.length / 1024).toFixed(0)} kB` };
}

/** Check a video against the screen profile with ffprobe. Returns problems; skipped with a warning only if ffprobe is not installed. */
function checkVideo(path: string): string[] {
  let out: string;
  try {
    out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,profile,pix_fmt,level,field_order,width,height,avg_frame_rate,r_frame_rate,bit_rate:format=bit_rate', '-of', 'json', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.warn(`  warning: ffprobe not found; ${basename(path)} was not checked against the video spec`);
      return [];
    }
    return [`ffprobe could not read the file: ${String((err as { stderr?: string }).stderr ?? err).trim().split('\n')[0]}`];
  }
  type Stream = { codec_name: string; profile?: string; pix_fmt?: string; level?: number; field_order?: string; width: number; height: number; avg_frame_rate: string; r_frame_rate: string; bit_rate?: string };
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
  const long = Math.max(v.width, v.height), short = Math.min(v.width, v.height);
  const problems: string[] = [];
  if (v.codec_name !== VIDEO_SPEC.codec) problems.push(`codec is ${v.codec_name}; screens need ${VIDEO_SPEC.codec}`);
  if (!(VIDEO_SPEC.pixelFormats as readonly string[]).includes(v.pix_fmt ?? '')) problems.push(`pixel format is ${v.pix_fmt}; screens need 8-bit 4:2:0 (yuv420p)`);
  if (v.profile && !(VIDEO_SPEC.profiles as readonly string[]).includes(v.profile)) problems.push(`H.264 profile ${v.profile} is not supported; use High or Main`);
  if (v.level !== undefined && v.level > VIDEO_SPEC.maxLevel) problems.push(`H.264 level ${v.level / 10} is above ${VIDEO_SPEC.maxLevel / 10}`);
  if (v.field_order && !['progressive', 'unknown'].includes(v.field_order)) problems.push('video is interlaced; screens need progressive');
  if (long > VIDEO_SPEC.maxWidth || short > VIDEO_SPEC.maxHeight) problems.push(`${v.width}x${v.height} is larger than ${VIDEO_SPEC.maxWidth}x${VIDEO_SPEC.maxHeight}`);
  if (!(fps > 0)) problems.push('frame rate could not be read');
  else if (fps > VIDEO_SPEC.maxFps + 0.5) problems.push(`${fps.toFixed(0)} fps is above ${VIDEO_SPEC.maxFps}`);
  if (!(bitrate > 0)) problems.push('bit rate could not be read');
  else if (bitrate > VIDEO_SPEC.maxBitrate) problems.push(`${(bitrate / 1e6).toFixed(1)} Mbit/s is above ${VIDEO_SPEC.maxBitrate / 1e6}`);
  return problems;
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const jsonFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []);

class Problems {
  list: string[] = [];
  add(where: string, messages: string[]) {
    for (const m of messages) this.list.push(`${where}: ${m}`);
  }
}

interface BuiltTemplate {
  manifest: TemplateManifest;
  html: string;
}

/** Bundle a template directory into a single HTML file with its script, styles and fonts inlined. */
export async function buildTemplate(dir: string, problems: Problems): Promise<BuiltTemplate> {
  const manifest = readJson<TemplateManifest>(join(dir, 'template.json'));
  const where = `template ${basename(dir)}`;
  problems.add(where, validateTemplateManifest(manifest));

  const common = { bundle: true, minify: true, write: false, target: 'chrome120', logLevel: 'silent' } as const;
  const js = await build({ ...common, entryPoints: [join(dir, 'main.ts')], format: 'iife' });
  const css = await build({ ...common, entryPoints: [join(dir, 'style.css')], loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' } });
  const script = js.outputFiles[0]!.text.replaceAll('</script', '<\\/script');
  const style = css.outputFiles[0]!.text;

  for (const rule of FORBIDDEN_CSS) if (rule.pattern.test(style)) problems.add(where, [rule.reason]);
  // The author's own files; the bundled SDK is trusted.
  const own = ['index.html', 'style.css', 'main.ts'].map((f) => readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/.*$/gm, '')).join('\n');
  for (const rule of FORBIDDEN_TEMPLATE_CODE) if (rule.pattern.test(own)) problems.add(where, [rule.reason]);

  let html = readFileSync(join(dir, 'index.html'), 'utf8');
  const before = html;
  html = html.replace(/<link rel="stylesheet" href="style\.css">/, () => `<style>${style}</style>`);
  html = html.replace(/<script type="module" src="main\.ts"><\/script>/, () => `<script>${script}</script>`);
  if (html === before || !html.includes('<style>') || !html.includes('<script>')) {
    problems.add(where, ['index.html must reference style.css and main.ts exactly as the template starter does']);
  }
  if (/\b(?:src|href)\s*=\s*["']https?:/i.test(html) || /url\(\s*["']?https?:/i.test(style)) {
    problems.add(where, ['a template may not load anything from the network']);
  }
  const bytes = Buffer.byteLength(html);
  if (bytes > TEMPLATE_BUDGET.maxBundleBytes) problems.add(where, [`bundle is ${bytes} bytes; the budget is ${TEMPLATE_BUDGET.maxBundleBytes}`]);
  console.log(`  template ${templateKey(manifest)}  ${(bytes / 1024).toFixed(0)} kB (budget ${TEMPLATE_BUDGET.maxBundleBytes / 1000} kB)`);
  // The bundle embeds this build's SDK, so it speaks this protocol for as long as it exists.
  return { manifest: { ...manifest, protocol: PROTOCOL_VERSION }, html };
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
    if (type.startsWith('video/') && !fitted.has(rel)) problems.add(where, checkVideo(path).map((p) => `${rel}: ${p}`));
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
      if (!built.has(s.template)) built.set(s.template, await buildTemplate(tdir, problems));
      const t = built.get(s.template)!;
      const key = templateKey(t.manifest);
      templates[key] = { manifest: t.manifest, html: addBlob(Buffer.from(t.html), 'text/html') };
      const assets: Record<string, string> = {};
      for (const [field, rel] of Object.entries(s.assets ?? {})) assets[field] = await addMedia(rel, where);
      const durationMs = s.durationMs ?? t.manifest.duration.defaultMs;
      spots.push({ id, name: s.name, kind: 'template', template: key, data: s.data ?? {}, assets, durationMs, ...(s.bindings ? { bindings: s.bindings } : {}) });
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
  const schedule = (sched.entries ?? []).map((e) => ({ ...e, targetId: e.targetId ?? (e.target === 'screen' ? screen.id : e.target === 'group' ? groups[0] : undefined) }));
  for (const e of schedule) {
    const elsewhere = (e.target === 'group' && !groups.includes(e.targetId ?? '')) || (e.target === 'screen' && e.targetId !== screen.id);
    if (elsewhere) console.warn(`  note: schedule entry ${e.id} targets ${e.target} "${e.targetId}", which is not this screen; it is left out`);
  }

  const files: CompileInput['files'] = {};
  for (const [hash, b] of blobs) files[hash] = { size: b.data.length, type: b.type };

  const result = await compileScreen(
    { screen, groups, templates, files, spots, playlists, dataSources, schedule, defaultPlaylist: sched.defaultPlaylist },
    { hash: (text) => sha256(text), now: new Date() },
  );
  problems.list.push(...result.problems);
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
  console.log(`  manifest ${manifest.id.slice(0, 16)}: ${Object.keys(manifest.spots).length} spots, ${Object.keys(manifest.playlists).length} playlists, ${Object.keys(manifest.files).length} files, ${(total / 1024).toFixed(0)} kB`);
  console.log(`  wrote ${outDir}`);
}

const [cmd, projectArg, ...rest] = process.argv.slice(2);
if (cmd !== 'build' || !projectArg) {
  console.error('usage: sf build <project-dir> [--out <dir>] [--templates <dir>]');
  process.exit(2);
}
const flag = (name: string, fallback: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1]! : fallback;
};
await buildProject(resolve(projectArg), resolve(flag('out', 'dist/content')), resolve(flag('templates', 'templates')));
