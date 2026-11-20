/**
 * Start the API and the CMS as a developer would (two processes, joined by the dev registry),
 * but on their own ports, with their own local database and their own registry, so a dev server
 * already running on this machine is neither used nor disturbed.
 */
import { chromium } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN_TOKEN, API_LOG, API_PORT, CMS_PORT, CMS_URL, FEEDS_DIR, PLACES, RUN_DIR } from './servers';

const apiDir = fileURLToPath(new URL('../../api/', import.meta.url));
const cmsDir = fileURLToPath(new URL('../', import.meta.url));
const rootDir = fileURLToPath(new URL('../../../', import.meta.url));

async function waitFor(url: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (res.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${url} did not come up`);
}

/**
 * Open-Meteo's geocoding as the API's `find_places` asks it (`GEOCODING_URL`), answering from
 * `PLACES`, so the run never reaches the internet. On a free port.
 */
async function geocodingStub(): Promise<{ url: string; close: () => void }> {
  const server = createServer((req, res) => {
    const name = new URL(req.url ?? '/', 'http://stub').searchParams.get('name')?.toLowerCase() ?? '';
    const results = PLACES.filter((p) => p.name.toLowerCase().startsWith(name));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(results.length ? { results, generationtime_ms: 0.1 } : { generationtime_ms: 0.1 }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('the geocoding stub is not listening');
  return { url: `http://127.0.0.1:${address.port}/v1/search`, close: () => server.close() };
}

/**
 * A file server for the links table sources read (issue #84): the dev API sends every feed fetch
 * here (`FEED_STUB_URL`), and it answers with the file in FEEDS_DIR named by the URL's last path
 * segment, which a test writes and edits. On a free port.
 */
async function feedServer(): Promise<{ url: string; close: () => void }> {
  const server = createServer((req, res) => {
    const file = join(FEEDS_DIR, basename(new URL(req.url ?? '/', 'http://stub').pathname));
    if (!existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': file.endsWith('.json') ? 'application/json' : 'text/csv' });
    res.end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('the feed server is not listening');
  return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}

/** True if something already answers on the port: another checkout's run, whose servers this run would otherwise use. */
async function answers(url: string) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

export default async function globalSetup() {
  for (const [name, url] of [
    ['E2E_API_PORT', `http://127.0.0.1:${API_PORT}/health`],
    ['E2E_CMS_PORT', `http://127.0.0.1:${CMS_PORT}/`],
  ] as const) {
    if (await answers(url)) throw new Error(`${url} is already in use (another e2e run?): set ${name} to a free port`);
  }
  rmSync(RUN_DIR, { recursive: true, force: true });
  mkdirSync(FEEDS_DIR, { recursive: true });
  const env = { ...process.env, CLOUDFLARE_DEV_REGISTRY_PATH: `${RUN_DIR}registry`, CLOUDFLARE_ENV: 'dev', NO_COLOR: '1' };
  const state = `${RUN_DIR}state`;

  const migrate = spawnSync('pnpm', ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--env', 'dev', '--persist-to', state], {
    cwd: apiDir,
    env,
    encoding: 'utf8',
  });
  if (migrate.status !== 0) throw new Error(`migrations failed:\n${migrate.stdout}\n${migrate.stderr}`);
  // The CMS serves the player build as its test screen and the spot editor's stage (vite.config.ts).
  // Built for this host: no CMS_ORIGIN.
  const player = spawnSync('pnpm', ['--filter', '@signforge/player', 'build'], { env: { ...env, CMS_ORIGIN: '' }, encoding: 'utf8' });
  if (player.status !== 0) throw new Error(`player build failed:\n${player.stdout}\n${player.stderr}`);

  const geocoding = await geocodingStub();
  const feeds = await feedServer();
  const log = openSync(API_LOG, 'a');
  const children: ChildProcess[] = [
    spawn(
      'pnpm',
      [
        'exec',
        'wrangler',
        'dev',
        '--env',
        'dev',
        '--port',
        String(API_PORT),
        '--persist-to',
        state,
        '--ip',
        '127.0.0.1',
        '--var',
        `LOCAL_S3_ORIGIN:http://127.0.0.1:${API_PORT}`,
        '--var',
        `ADMIN_TOKEN:${ADMIN_TOKEN}`,
        '--var',
        `GEOCODING_URL:${geocoding.url}`,
        '--var',
        `FEED_STUB_URL:${feeds.url}`,
        // GET /__scheduled runs the Cron Triggers' jobs: how a test makes the poller run now.
        '--test-scheduled',
      ],
      {
        cwd: apiDir,
        env,
        stdio: ['ignore', log, log],
        detached: true,
      },
    ),
    spawn('pnpm', ['exec', 'vite', 'dev', '--port', String(CMS_PORT)], {
      cwd: cmsDir,
      env,
      stdio: ['ignore', openSync(`${RUN_DIR}cms.log`, 'a'), openSync(`${RUN_DIR}cms.log`, 'a')],
      detached: true,
    }),
  ];

  await waitFor(`http://127.0.0.1:${API_PORT}/health`);
  // The base templates and fonts, as a deploy seeds them, for the spot editor.
  const seed = spawnSync('pnpm', ['seed:templates', '--api', `http://127.0.0.1:${API_PORT}`], {
    cwd: rootDir,
    env: { ...env, SF_ADMIN_TOKEN: ADMIN_TOKEN },
    encoding: 'utf8',
  });
  if (seed.status !== 0) throw new Error(`template seed failed:\n${seed.stdout}\n${seed.stderr}`);
  await waitFor(`${CMS_URL}/sign-in`);
  // The CMS reaches the API through the registry; wait until the binding answers.
  await waitFor(`${CMS_URL}/api/sign-in-options`);
  // Vite optimises dependencies on the first browser load and may reload the page; do that now,
  // not in the middle of a test.
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${CMS_URL}/sign-in`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1_000);
    await page.reload();
    await page.waitForLoadState('networkidle');
  } finally {
    await browser.close();
  }

  return async () => {
    geocoding.close();
    feeds.close();
    for (const child of children) {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {}
    }
  };
}
