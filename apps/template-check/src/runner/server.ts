/**
 * The runner's HTTP API, inside the container. Only the check Worker's Durable Object reaches it.
 *
 *   GET  /health  { image, browser, network }; it listens only once the browser is up
 *   POST /check   { manifest, html } -> TemplateRuntimeReport; `?startMs=` is the container's start, which the Worker timed
 *
 * It probes the network once at start. The container must have none: if the probe gets an answer,
 * every check is refused (503), so a container started with Internet access never passes a template.
 */
import { parseTemplateManifest, TEMPLATE_BUDGET, type TemplateRuntimeReport } from '@signforge/contract';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { launchBrowser } from './browser';
import { checkTemplate } from './check';

export interface RunnerOptions {
  port: number;
  /** The image this runs in, for the report: the Worker passes its digest-pinned reference. */
  image: string;
  /** An outside URL the container must not reach. */
  probeUrl: string;
}

/** Room for a bundle at its budget, JSON-escaped, and its manifest. */
const MAX_BODY_BYTES = 4 * TEMPLATE_BUDGET.maxBundleBytes;

/** Whether `url` answers. Any failure (no DNS, no route, a timeout) is a closed network. */
async function probe(url: string): Promise<{ closed: boolean; detail: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return { closed: false, detail: `${url} answered ${res.status}` };
  } catch (e) {
    const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : '';
    return { closed: true, detail: `${url} could not be reached (${e instanceof Error ? e.message : String(e)}${cause})` };
  }
}

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const b = Buffer.from(chunk);
    size += b.byteLength;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

export async function startRunner(opts: RunnerOptions): Promise<Server> {
  const [browser, network] = await Promise.all([launchBrowser(), probe(opts.probeUrl)]);
  const runner = { image: opts.image, browser: `Chromium ${browser.version()}` };
  // One check at a time: two 1080p renders at once would slow both past the ready limit.
  let queue: Promise<unknown> = Promise.resolve();

  async function check(req: IncomingMessage, res: ServerResponse) {
    if (!network.closed) return send(res, 503, { error: `the check container can reach the network (${network.detail}); it must not` });
    const text = await readBody(req);
    if (text === undefined) return send(res, 413, { error: `the body is over ${MAX_BODY_BYTES} bytes` });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return send(res, 400, { error: 'the body is not JSON' });
    }
    const manifest = parseTemplateManifest(Reflect.get(Object(body), 'manifest'));
    const html: unknown = Reflect.get(Object(body), 'html');
    if (!manifest.ok || typeof html !== 'string') return send(res, 400, { error: 'send { manifest, html }: a template manifest and its built HTML' });
    const startMs = Number(new URL(req.url ?? '/', 'http://runner').searchParams.get('startMs') ?? 0);
    const run = queue.then(async () => {
      const started = performance.now();
      const { problems, renders } = await checkTemplate(browser, manifest.value, html);
      const report: TemplateRuntimeReport = {
        ok: !problems.length,
        problems,
        runner,
        renders,
        cost: { startMs: Number.isFinite(startMs) && startMs > 0 ? startMs : 0, checkMs: Math.round(performance.now() - started) },
      };
      return report;
    });
    queue = run.catch(() => undefined);
    send(res, 200, await run);
  }

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ...runner, network });
    if (req.method === 'POST' && req.url?.split('?')[0] === '/check')
      return void check(req, res).catch((e: unknown) => send(res, 500, { error: e instanceof Error ? e.message : String(e) }));
    return send(res, 404, { error: 'GET /health or POST /check' });
  });
  server.on('close', () => void browser.close());
  await new Promise<void>((resolve) => server.listen(opts.port, resolve));
  return server;
}
