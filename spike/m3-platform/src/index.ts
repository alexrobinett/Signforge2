/**
 * M3-00 spike Worker. Each route is one proof; RESULTS.md records what they returned on real
 * Cloudflare. Throwaway: nothing here is production code.
 */
import { runAuthFlow } from './auth-flow';
import { consumeFanout, type FanoutMessage } from './fanout';
import { PROBE_TARGETS, probe } from './fetch-probe';
import { probeForeignKeys } from './fk';
import { expandCalendar, SAMPLE_ICS } from './ical';
import { readMp4Header } from './mp4';

export { SpikeScreen } from './screen';

const LNA_PAGE = `<!doctype html><title>lna</title><script>
(async () => {
  const out = {};
  try { out.permission = (await navigator.permissions.query({ name: 'local-network-access' })).state; } catch (e) { out.permission = 'query failed: ' + e.message; }
  try { out.loopbackPermission = (await navigator.permissions.query({ name: 'loopback-network' })).state; } catch (e) { out.loopbackPermission = 'query failed: ' + e.message; }
  for (const url of ['http://127.0.0.1:8090/', 'http://localhost:8090/']) {
    const t = Date.now();
    try { const r = await fetch(url, { mode: 'no-cors', signal: AbortSignal.timeout(8000) }); out[url] = 'reached: ' + r.type + ' in ' + (Date.now() - t) + ' ms'; }
    catch (e) { out[url] = 'blocked: ' + e.name + ': ' + e.message + ' after ' + (Date.now() - t) + ' ms'; }
  }
  window.__lna = out;
})();
</script>`;

async function subrequests(env: Env, kind: string, n: number) {
  let done = 0;
  try {
    for (; done < n; done++) {
      if (kind === 'fetch') await (await fetch('https://cloudflare.com/cdn-cgi/trace')).text();
      else if (kind === 'd1') await env.DB.prepare('SELECT ?1 AS n').bind(done).first();
      else if (kind === 'do') await env.SCREEN.getByName('subrequests').nudge(String(done));
      else throw new Error(`unknown kind ${kind}`);
    }
    return { kind, requested: n, completed: done };
  } catch (e) {
    return { kind, requested: n, completed: done, error: String((e as Error).message).slice(0, 200) };
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const q = url.searchParams;
    switch (url.pathname) {
      case '/auth-flow':
        return Response.json(await runAuthFlow(env, url.origin));
      case '/fk':
        return Response.json(await probeForeignKeys(env.DB));
      case '/fetch-probe':
        return Response.json(await Promise.all(PROBE_TARGETS.map(probe)));
      case '/ical':
        return Response.json(expandCalendar(SAMPLE_ICS, new Date(q.get('from') ?? '2026-11-20T00:00:00Z')));
      case '/mp4': {
        const media = (env as { MEDIA?: R2Bucket }).MEDIA;
        if (!media) return new Response('R2 not bound', { status: 501 });
        return Response.json(await readMp4Header(media, q.get('key') ?? '', Number(q.get('chunk') ?? 65536)));
      }
      case '/images': {
        // Server-side fallback for uploads with no browser: scale with the Images binding.
        const images = (env as { IMAGES?: ImagesBinding }).IMAGES;
        if (!images || !request.body) return new Response('IMAGES not bound or no body', { status: 501 });
        const [a, b] = request.body.tee();
        const info = await images.info(a);
        try {
          const out = await images.input(b).transform({ width: Number(q.get('width') ?? 320) }).output({ format: 'image/webp' });
          const bytes = (await out.response().arrayBuffer()).byteLength;
          return Response.json({ info, outType: out.contentType(), outBytes: bytes });
        } catch (e) {
          return Response.json({ info, error: String((e as Error).message) }, { status: 500 });
        }
      }
      case '/lna':
        // A public https page that tries to reach the device's loopback player port. Opened in
        // the Pi's Chromium over DevTools; the result lands in window.__lna.
        return new Response(LNA_PAGE, { headers: { 'content-type': 'text/html' } });
      case '/subrequests':
        return Response.json(await subrequests(env, q.get('kind') ?? 'fetch', Number(q.get('n') ?? 10)));
      case '/fanout': {
        const run = q.get('run') ?? crypto.randomUUID().slice(0, 8);
        const n = Number(q.get('n') ?? 150);
        const msgs: MessageSendRequest<FanoutMessage>[] = [];
        for (let i = 0; i < n; i++) msgs.push({ body: { run, screen: `s${i}`, manifestId: `m-${run}` } });
        for (let i = 0; i < msgs.length; i += 100) await env.FANOUT.sendBatch(msgs.slice(i, i + 100));
        return Response.json({ run, sent: n });
      }
      case '/fanout-result': {
        const run = q.get('run') ?? '';
        const batches = await env.DB.prepare('SELECT batch_size, subrequests, error, at FROM fanout_batches WHERE run = ? ORDER BY at').bind(run).all();
        const screens = await env.DB.prepare('SELECT count(*) AS n FROM fanout_screens WHERE run = ?').bind(run).first();
        return Response.json({ run, screens, batches: batches.results });
      }
      case '/ws': {
        const stub = env.SCREEN.getByName(q.get('screen') ?? 'hibernation');
        if (q.has('reset')) {
          await stub.resetCounters();
          return new Response('reset');
        }
        return stub.fetch(request);
      }
      default:
        return new Response('sf-spike-m3', { status: 404 });
    }
  },
  async queue(batch, env) {
    await consumeFanout(batch as MessageBatch<FanoutMessage>, env);
  },
} satisfies ExportedHandler<Env>;
