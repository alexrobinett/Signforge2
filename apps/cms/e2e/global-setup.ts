/**
 * Start the API and the CMS as a developer would (two processes, joined by the dev registry),
 * but on their own ports, with their own local database and their own registry, so a dev server
 * already running on this machine is neither used nor disturbed.
 */
import { chromium } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { API_LOG, API_PORT, CMS_PORT, CMS_URL, RUN_DIR } from './servers';

const apiDir = fileURLToPath(new URL('../../api/', import.meta.url));
const cmsDir = fileURLToPath(new URL('../', import.meta.url));
const rootDir = fileURLToPath(new URL('../../../', import.meta.url));
/** Turns on the API's /admin routes for this run only, so the templates can be seeded. */
const ADMIN_TOKEN = `e2e-${crypto.randomUUID()}`;

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

export default async function globalSetup() {
  rmSync(RUN_DIR, { recursive: true, force: true });
  mkdirSync(RUN_DIR, { recursive: true });
  const env = { ...process.env, CLOUDFLARE_DEV_REGISTRY_PATH: `${RUN_DIR}registry`, CLOUDFLARE_ENV: 'dev', NO_COLOR: '1' };
  const state = `${RUN_DIR}state`;

  const migrate = spawnSync('pnpm', ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--env', 'dev', '--persist-to', state], {
    cwd: apiDir,
    env,
    encoding: 'utf8',
  });
  if (migrate.status !== 0) throw new Error(`migrations failed:\n${migrate.stdout}\n${migrate.stderr}`);

  // The CMS serves the player build at /player/ for the spot editor's stage.
  const player = spawnSync('pnpm', ['player'], { cwd: cmsDir, env, encoding: 'utf8' });
  if (player.status !== 0) throw new Error(`player build failed:\n${player.stdout}\n${player.stderr}`);

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
    for (const child of children) {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {}
    }
  };
}
