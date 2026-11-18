// The poller's fetch guards (docs/backend-plan.md, Data sources, Fetch safety). Feed URLs are
// user-supplied: each guard here is shown refusing its own case. No network: fetch and DNS are stubbed.
import { describe, expect, it } from 'vitest';
import { dohResolver, FETCH_TIMEOUT_MS, guardedFetch, type FetchGuards } from '../src/data/fetch';

type Route = (req: Request) => Response | Promise<Response>;

/** A fetch that answers from `routes` by URL, recording every request; DNS answers from `dns`. */
function stub(routes: Record<string, Route>, dns: Record<string, string[]> = {}) {
  const requests: Request[] = [];
  const guards: FetchGuards = {
    fetch: async (input, init) => {
      const req = new Request(input, init);
      requests.push(req);
      const route = routes[req.url];
      if (!route) throw new TypeError(`no route for ${req.url}`);
      return route(req);
    },
    resolve: async (host) => dns[host] ?? ['93.184.216.34'],
  };
  return { guards, requests };
}

const ok =
  (body: string, headers: Record<string, string> = {}) =>
  () =>
    new Response(body, { headers });
const redirect =
  (to: string, status = 302) =>
  () =>
    new Response(null, { status, headers: { location: to } });

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'fetched',
    (e: unknown) => (e as { code?: string }).code ?? String(e),
  );

describe('guardedFetch', () => {
  it('fetches an https feed on its default port', async () => {
    const { guards } = stub({ 'https://feed.test/a.xml': ok('<rss/>', { etag: '"v1"', 'last-modified': 'Tue, 17 Nov 2026 12:00:00 GMT' }) });
    expect(await guardedFetch('https://feed.test:443/a.xml', {}, guards)).toEqual({
      status: 'ok',
      body: '<rss/>',
      etag: '"v1"',
      lastModified: 'Tue, 17 Nov 2026 12:00:00 GMT',
    });
  });

  it('asks conditionally and reports an unchanged feed', async () => {
    const { guards, requests } = stub({ 'https://feed.test/a.xml': () => new Response(null, { status: 304 }) });
    expect(await guardedFetch('https://feed.test/a.xml', { etag: '"v1"', lastModified: 'Tue, 17 Nov 2026 12:00:00 GMT' }, guards)).toEqual({
      status: 'not-modified',
    });
    expect(requests[0]?.headers.get('if-none-match')).toBe('"v1"');
    expect(requests[0]?.headers.get('if-modified-since')).toBe('Tue, 17 Nov 2026 12:00:00 GMT');
  });

  it('refuses anything but https', async () => {
    for (const url of ['http://feed.test/a.xml', 'ftp://feed.test/a', 'file:///etc/passwd', 'not a url'])
      expect(await refusal(guardedFetch(url, {}, stub({}).guards)), url).toBe(url === 'not a url' ? 'bad-url' : 'not-https');
  });

  it('refuses a port other than the default', async () => {
    expect(await refusal(guardedFetch('https://feed.test:8443/a.xml', {}, stub({}).guards))).toBe('port');
  });

  it('refuses an IP address, however it is written', async () => {
    for (const url of ['https://93.184.216.34/a', 'https://[2606:4700::1111]/a', 'https://2130706433/a', 'https://0x7f.1/a', 'https://127.1/a'])
      expect(await refusal(guardedFetch(url, {}, stub({}).guards)), url).toBe('ip-literal');
  });

  it('refuses a host that is local, or that resolves to a private or reserved address', async () => {
    const dns = {
      'ten.test': ['10.1.2.3'],
      'cgnat.test': ['100.64.0.9'],
      'v6.test': ['93.184.216.34', '::1'],
      'mapped.test': ['::ffff:192.168.1.1'],
      'ula.test': ['fd00::5'],
    };
    for (const host of ['localhost', 'printer.local', 'db.internal', 'ten.test', 'cgnat.test', 'v6.test', 'mapped.test', 'ula.test'])
      expect(await refusal(guardedFetch(`https://${host}/a`, {}, stub({}, dns).guards)), host).toBe('private-address');
  });

  it('refuses a host that does not resolve', async () => {
    expect(await refusal(guardedFetch('https://gone.test/a', {}, stub({}, { 'gone.test': [] }).guards))).toBe('dns');
  });

  it('follows up to 3 redirects, checking each one, and refuses a 4th', async () => {
    const chain = {
      'https://a.test/': redirect('https://b.test/'),
      'https://b.test/': redirect('/c', 301),
      'https://b.test/c': redirect('https://d.test/', 307),
      'https://d.test/': ok('done'),
    };
    expect(await guardedFetch('https://a.test/', {}, stub(chain).guards)).toMatchObject({ status: 'ok', body: 'done' });
    const { guards, requests } = stub({ ...chain, 'https://d.test/': redirect('https://e.test/'), 'https://e.test/': ok('too far') });
    expect(await refusal(guardedFetch('https://a.test/', {}, guards))).toBe('too-many-redirects');
    expect(requests.map((r) => r.url)).not.toContain('https://e.test/');
    for (const r of requests) expect(r.redirect).toBe('manual');
  });

  it('refuses a redirect to plain http or to a private host', async () => {
    expect(await refusal(guardedFetch('https://a.test/', {}, stub({ 'https://a.test/': redirect('http://a.test/') }).guards))).toBe('not-https');
    const inside = stub({ 'https://a.test/': redirect('https://inside.test/') }, { 'inside.test': ['192.168.0.10'] });
    expect(await refusal(guardedFetch('https://a.test/', {}, inside.guards))).toBe('private-address');
    expect(inside.requests.map((r) => r.url)).toEqual(['https://a.test/']);
  });

  it(`gives up after ${FETCH_TIMEOUT_MS / 1000} seconds`, async () => {
    expect(FETCH_TIMEOUT_MS).toBe(5000);
    const hang: Route = (req) => new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(req.signal.reason)));
    expect(await refusal(guardedFetch('https://slow.test/', {}, { ...stub({ 'https://slow.test/': hang }).guards, timeoutMs: 20 }))).toBe('timeout');
  });

  it('counts the DNS lookups in the deadline, and reports one that runs it out as dns', async () => {
    const timeoutMs = 50;
    // A DNS-over-HTTPS server that answers after ten deadlines, unless the request is aborted first.
    const slowDns: typeof fetch = (_input, init) =>
      new Promise((answer, reject) => {
        const late = setTimeout(() => answer(Response.json({ Answer: [{ type: 1, data: '93.184.216.34' }] })), 10 * timeoutMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(late);
          reject(init.signal?.reason);
        });
      });
    const guards = { ...stub({ 'https://feed.test/': ok('late') }).guards, resolve: dohResolver(slowDns), timeoutMs };
    const start = Date.now();
    const code = await refusal(guardedFetch('https://feed.test/', {}, guards));
    // Well under the ~10 deadlines the old separate lookup timer took, with room for a slow runner.
    expect({ code, inTime: Date.now() - start < 5 * timeoutMs }).toEqual({ code: 'dns', inTime: true });
  });

  it("reports Cloudflare's refusal to reach a private address as a blocked address, not the feed's answer", async () => {
    const cf = (status: number, code: number) => () => new Response(`error code: ${code}`, { status });
    expect(await refusal(guardedFetch('https://a.test/', {}, stub({ 'https://a.test/': cf(403, 1003) }).guards))).toBe('blocked-address');
    expect(await refusal(guardedFetch('https://a.test/', {}, stub({ 'https://a.test/': cf(530, 1016) }).guards))).toBe('blocked-address');
  });

  it('reports an error status by category, never echoing the body', async () => {
    const e = await guardedFetch(
      'https://a.test/',
      {},
      stub({ 'https://a.test/': () => new Response('secret token in the page', { status: 500 }) }).guards,
    ).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'http-status', status: 500 });
    expect(String((e as Error).message)).not.toContain('secret');
    expect(
      await refusal(guardedFetch('https://a.test/', {}, stub({ 'https://a.test/': () => Promise.reject(new TypeError('connection reset')) }).guards)),
    ).toBe('network');
  });

  it('refuses a body over 1 MB without reading it all', async () => {
    const big = () => new Response(new ReadableStream({ pull: (c) => c.enqueue(new Uint8Array(64 * 1024)) }));
    expect(await refusal(guardedFetch('https://a.test/', {}, stub({ 'https://a.test/': big }).guards))).toBe('too-large');
  });
});
