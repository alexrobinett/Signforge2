#!/usr/bin/env tsx
/**
 * Screenshot every spot of a built project through the real player, for visual review.
 *
 *   tsx scripts/spot-shots.ts --content <sf build output> --out <dir> [--chrome <path>] [--sizes 1920x1080,1080x1920] [--spots a,b]
 *     [--scale 0.25 --format webp]
 *
 * Serves `dist/player` (run `pnpm build:player` first) with the content under it, launches
 * Chromium headless, plays each spot on its own at each size, and saves two frames per spot:
 * after the intro (`-a`) and near the end (`-b`). Writes `index.json` with each spot's resolved
 * data (live snapshots applied) and any player error, so a reviewer can check what is shown
 * against what was meant to be shown.
 *
 * Chromium, not the Pi: this checks how spots look, not how fast they run.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    content: { type: 'string' },
    out: { type: 'string' },
    chrome: { type: 'string', default: process.env.CHROME },
    sizes: { type: 'string', default: '1920x1080,1080x1920' },
    spots: { type: 'string' },
    // A frame drawn at full size and saved smaller, as scripts/template-thumbnails.ts saves them.
    scale: { type: 'string', default: '1' },
    format: { type: 'string', default: 'png' },
  },
});
if (!args.content || !args.out || !args.chrome) {
  console.error('usage: spot-shots --content <dir> --out <dir> --chrome <path to Chromium> [--sizes WxH,...]');
  process.exit(2);
}
const root = resolve(import.meta.dirname, '..');
const playerDir = join(root, 'dist/player');
const contentDir = resolve(args.content);
const outDir = resolve(args.out);
mkdirSync(outDir, { recursive: true });
if (!existsSync(join(playerDir, 'index.html'))) throw new Error('dist/player is missing: run pnpm build:player');

// ---------------------------------------------------------------- server
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = path.startsWith('/content/') ? join(contentDir, path.slice('/content/'.length)) : join(playerDir, path === '/' ? 'index.html' : path);
  try {
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;

// ---------------------------------------------------------------- browser
const profile = mkdtempSync(join(tmpdir(), 'sf-shots-'));
const chrome = spawn(
  args.chrome,
  [
    '--headless=new',
    '--use-mock-keychain',
    '--password-store=basic',
    '--no-first-run',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--autoplay-policy=no-user-gesture-required',
    '--force-device-scale-factor=1',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
const wsUrl = await new Promise<string>((resolveUrl, reject) => {
  let buf = '';
  chrome.stderr.on('data', (d: Buffer) => {
    buf += d.toString();
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
    if (m) resolveUrl(m[1]!);
  });
  chrome.on('exit', () => reject(new Error('Chromium exited')));
});
const targets = (await (await fetch(wsUrl.replace('ws://', 'http://').replace(/\/devtools\/browser\/.*/, '/json'))).json()) as {
  type: string;
  webSocketDebuggerUrl: string;
}[];
const ws = new WebSocket(targets.find((t) => t.type === 'page')!.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let nextId = 0;
const pending = new Map<number, (v: Record<string, unknown>) => void>();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data)) as { id?: number; result?: Record<string, unknown> };
  if (m.id !== undefined) pending.get(m.id)?.(m.result ?? {});
});
const call = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<Record<string, unknown>>((r) => {
    const id = ++nextId;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async <T>(expression: string): Promise<T> =>
  ((await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result as { value: T }).value;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- shots
const manifest = JSON.parse(readFileSync(join(contentDir, 'manifest.json'), 'utf8')) as { spots: Record<string, { name: string; durationMs: number }> };
const index: Record<string, unknown>[] = [];
for (const size of args.sizes!.split(',')) {
  const [width, height] = size.split('x').map(Number) as [number, number];
  await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const only = args.spots?.split(',');
  for (const [id, spot] of Object.entries(manifest.spots).filter(([id]) => !only || only.includes(id))) {
    await call('Page.navigate', { url: `http://127.0.0.1:${port}/index.html?content=./content&poll=600&transition=cut&spots=${id}` });
    // Wait until the spot is on screen, then catch it after its intro and near its end.
    let started = false;
    for (let i = 0; i < 100 && !started; i++) {
      await sleep(100);
      started = (await evaluate<number>('window.__sf ? __sf.played : 0').catch(() => 0)) >= 1;
    }
    const shot = async (suffix: string) => {
      const clip = { x: 0, y: 0, width, height, scale: Number(args.scale) };
      const { data } = (await call('Page.captureScreenshot', { format: args.format, quality: 82, clip })) as { data: string };
      const file = `${id}-${width}x${height}-${suffix}.${args.format}`;
      writeFileSync(join(outDir, file), Buffer.from(data, 'base64'));
      return file;
    };
    await sleep(Math.min(2500, spot.durationMs * 0.3));
    const a = await shot('a');
    await sleep(Math.max(0, spot.durationMs * 0.85 - Math.min(2500, spot.durationMs * 0.3)));
    const b = await shot('b');
    const info = await evaluate<{ error: string; skipped: number; data: Record<string, string> }>(
      '({ error: __sf.lastError, skipped: __sf.skipped, data: __sf.data })',
    );
    // `data`: when each live source's snapshot was fetched, as the player held it at the end of the
    // play. A bound source missing here means the spot showed its static fallback.
    index.push({ spot: id, name: spot.name, size, started, frames: [a, b], data: info.data, playerError: info.error || undefined, skipped: info.skipped });
    console.log(`  ${id} ${size}${started ? '' : '  NOT STARTED'}${info.error ? `  error: ${info.error}` : ''}`);
  }
}
writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2));
ws.close();
chrome.kill();
server.close();
console.log(`wrote ${index.length * 2} screenshots to ${outDir}`);
