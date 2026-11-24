/**
 * Start the API (`wrangler dev`) and the built CMS (`vite preview`), joined by the dev registry,
 * but on their own ports, with their own local database and their own registry, so a dev server
 * already running on this machine is neither used nor disturbed.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADMIN_TOKEN,
  ANTHROPIC_STUB_KEY,
  ANTHROPIC_STUB_MODELS,
  API_LOG,
  API_PORT,
  CMS_PORT,
  CMS_URL,
  ENDPOINT_STUB_KEY,
  ENDPOINT_STUB_MODELS,
  FEEDS_DIR,
  PLACES,
  portTaken,
  RUN_DIR,
  STUB_CARD,
  STUB_DRAFT,
  STUB_DRAFTED,
  STUB_FILL,
  STUB_MENU,
} from './servers';

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
 * The drawer's scripted turn. On a spot's page (#268): read the spot, draft a punchier headline and a
 * QR link from its data as read, then `STUB_DRAFTED`. Anywhere else (#267): read the screens' status,
 * then `STUB_CARD`.
 */
function drawerStep(messages: { role: string; content: unknown }[]): { name: string; input: unknown } {
  const first = typeof messages[0]?.content === 'string' ? messages[0].content : '';
  const page = /<page>\n(\{.*\})\n<\/page>/.exec(first)?.[1];
  const spotId: string | undefined = page ? JSON.parse(page).ids?.spotId : undefined;
  const last = messages.at(-1)?.content;
  const result = Array.isArray(last) && last[0]?.type === 'tool_result' ? String(last[0].content) : undefined;
  const asked = messages.at(-2)?.content;
  const lastCall = Array.isArray(asked) ? asked.find((b: { type: string }) => b.type === 'tool_use')?.name : undefined;
  if (!spotId) return result ? { name: 'answer', input: STUB_CARD } : { name: 'list_screen_status', input: {} };
  if (!result) return { name: 'get_spot', input: { spotId } };
  if (lastCall === 'get_spot') {
    const read = JSON.parse(
      result
        .replace(/^<data>\n/, '')
        .replace(/\n<\/data>$/, '')
        .replaceAll('&lt;', '<'),
    );
    return { name: 'update_spot', input: { spotId, data: { ...read.spot.data, ...STUB_DRAFT } } };
  }
  return { name: 'answer', input: STUB_DRAFTED };
}

/**
 * Anthropic's API as the agent's adapter asks it (`ANTHROPIC_BASE_URL`, apps/api src/agent): the
 * Models API, where the stub key gets `ANTHROPIC_STUB_MODELS` and any other key Anthropic's 401; and
 * the Messages API for the fill (#263), which answers every call with `STUB_FILL` for the Photo
 * Promo template, or, asked to update a Menu Board (#264), with `STUB_MENU`; and the drawer's tool
 * loop (#267), a read of the screens' status and then `STUB_CARD`. On a free port, so the run never reaches the internet or spends a token.
 */
async function anthropicStub(): Promise<{ url: string; close: () => void }> {
  const server = createServer((req, res) => {
    const known = req.headers.authorization === `Bearer ${ANTHROPIC_STUB_KEY}` || req.headers['x-api-key'] === ANTHROPIC_STUB_KEY;
    const path = new URL(req.url ?? '/', 'http://stub').pathname;
    if (path === '/v1/messages' && known) {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        const asked = JSON.parse(body);
        // The drawer's tool loop (#267): first a read, then the answer, as `STUB_CARD`.
        if (asked.tools) {
          const call = drawerStep(asked.messages);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'msg_stub',
              type: 'message',
              role: 'assistant',
              model: asked.model,
              content: [{ type: 'tool_use', id: `toolu_${asked.messages.length}`, ...call }],
              stop_reason: 'tool_use',
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          );
          return;
        }
        const keys: string[] = asked.output_config.format.schema.properties.template.enum;
        const template = keys.find((k) => k.startsWith('base/photo-promo@')) ?? keys[0] ?? '';
        const { name, ...data } = template.startsWith('base/menu-board@') ? STUB_MENU : STUB_FILL;
        const text = JSON.stringify({ template, name, data_json: JSON.stringify(data), unsure: ['price'] });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg_stub',
            type: 'message',
            role: 'assistant',
            model: asked.model,
            content: [{ type: 'text', text }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      });
      return;
    }
    if (path !== '/v1/models') return void res.writeHead(404).end();
    res.writeHead(known ? 200 : 401, { 'content-type': 'application/json' });
    const models = ANTHROPIC_STUB_MODELS.map((id) => ({ type: 'model', id, display_name: id, created_at: '2026-10-01T00:00:00Z' }));
    res.end(
      JSON.stringify(
        known
          ? { data: models, has_more: false, first_id: models[0]!.id, last_id: models.at(-1)!.id }
          : { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('the Anthropic stub is not listening');
  return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}

/**
 * A file server for the links table sources read (issue #84): the dev API sends every feed fetch
 * here (`FEED_STUB_URL`), and it answers with the file in FEEDS_DIR named by the URL's last path
 * segment, which a test writes and edits; and, for any host's /v1/models, an OpenAI-compatible
 * endpoint's model list to the stub key (#262). On a free port.
 */
async function feedServer(): Promise<{ url: string; close: () => void }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://stub').pathname;
    // An OpenAI-compatible endpoint's model list (#262): every host's fetch lands here in dev, so its key is checked here.
    if (path.endsWith('/v1/models')) {
      const known = req.headers.authorization === `Bearer ${ENDPOINT_STUB_KEY}`;
      res.writeHead(known ? 200 : 401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(known ? { object: 'list', data: ENDPOINT_STUB_MODELS.map((id) => ({ id, object: 'model' })) } : { error: { message: 'invalid key' } }),
      );
      return;
    }
    const file = join(FEEDS_DIR, basename(path));
    if (!existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': file.endsWith('.json') ? 'application/json' : file.endsWith('.html') ? 'text/html' : 'text/csv' });
    res.end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('the feed server is not listening');
  return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}

export default async function globalSetup() {
  for (const [name, port] of [
    ['E2E_API_PORT', API_PORT],
    ['E2E_CMS_PORT', CMS_PORT],
  ] as const) {
    if (await portTaken(port)) throw new Error(`port ${port} is already in use (another e2e run?): set ${name} to a free port`);
  }
  rmSync(RUN_DIR, { recursive: true, force: true });
  mkdirSync(FEEDS_DIR, { recursive: true });
  const env = { ...process.env, CLOUDFLARE_DEV_REGISTRY_PATH: `${RUN_DIR}registry`, CLOUDFLARE_ENV: 'dev', NO_COLOR: '1' };
  const state = `${RUN_DIR}state`;

  // The migrations beside the builds. The player build is the CMS's test screen and stage
  // (vite.config.ts), built for this host: no CMS_ORIGIN. The CMS is built, as it deploys, for
  // `vite preview`: `vite dev` compiled each module on its first request, which took seconds.
  await Promise.all([
    run('migrations', ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--env', 'dev', '--persist-to', state], { cwd: apiDir, env }),
    run('player build', ['--filter', '@signforge/player', 'build'], { env: { ...env, CMS_ORIGIN: '' } }).then(() =>
      run('CMS build', ['exec', 'vite', 'build'], { cwd: cmsDir, env }),
    ),
  ]);

  const geocoding = await geocodingStub();
  const feeds = await feedServer();
  const anthropic = await anthropicStub();
  const log = openSync(API_LOG, 'a');
  const cmsLog = openSync(`${RUN_DIR}cms.log`, 'a');
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
        '--var',
        `ANTHROPIC_BASE_URL:${anthropic.url}`,
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
    spawn('pnpm', ['exec', 'vite', 'preview', '--port', String(CMS_PORT), '--strictPort'], {
      cwd: cmsDir,
      env,
      stdio: ['ignore', cmsLog, cmsLog],
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
  // A template with two named sources (#193), as no base template has yet.
  const fixture = spawnSync(
    'pnpm',
    ['exec', 'tsx', 'packages/cli/src/sf.ts', 'template', 'push', 'apps/cms/e2e/fixtures/two-sources', '--api', `http://127.0.0.1:${API_PORT}`, '--approve'],
    {
      cwd: rootDir,
      env: { ...env, SF_ADMIN_TOKEN: ADMIN_TOKEN },
      encoding: 'utf8',
    },
  );
  if (fixture.status !== 0) throw new Error(`fixture template push failed:\n${fixture.stdout}\n${fixture.stderr}`);
  await waitFor(`${CMS_URL}/sign-in`);
  // The CMS reaches the API through the registry; wait until the binding answers.
  await waitFor(`${CMS_URL}/api/sign-in-options`);

  return async () => {
    geocoding.close();
    feeds.close();
    anthropic.close();
    // Each server is its own process group (pnpm, wrangler or vite, workerd): asked to stop, then
    // killed, so no workerd is left holding a port for the next run.
    await Promise.all(
      children.map(async (child) => {
        if (!child.pid) return;
        const exited = new Promise((resolve) => child.once('exit', resolve));
        signal(child.pid, 'SIGTERM');
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
        signal(child.pid, 'SIGKILL');
      }),
    );
  };
}

/** Signal a process group that may already be gone. */
function signal(pid: number, name: NodeJS.Signals) {
  try {
    process.kill(-pid, name);
  } catch {}
}

/** Run `pnpm <args>` to its end, its output kept for the error if it fails. */
function run(what: string, args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv }) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('pnpm', args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${what} failed:\n${output}`))));
  });
}
