// The device tree against local D1 and R2: credentials, the three content routes, and what a
// screen may not reach.
import type { ScreenManifest } from '@signforge/contract';
import { scoped } from '@signforge/db';
import { seedOrg, type SeededOrg } from '@signforge/db/testing';
import { env, exports } from 'cloudflare:workers';
import { FONTS } from '@signforge/compiler';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintCredential, parseCredential } from '../src/device/credential';
import { baseBlobKey, manifestKey, orgBlobKey } from '../src/r2';

const BASE = 'https://api.test/v1/device';
const sha = (c: string) => c.repeat(64);

/** Enough of a manifest for the routes: they read its files, templates and data sources. */
function manifest(id: string, files: string[], extra: Partial<ScreenManifest> = {}): ScreenManifest {
  return {
    schema: 2,
    id,
    generatedAt: '2026-11-17T00:00:00.000Z',
    screen: { id: 'x', name: 'x', timezone: 'UTC', orientation: 'landscape' },
    files: Object.fromEntries(files.map((f) => [f, { size: 4, type: f === BASE_HTML ? 'text/html' : 'image/png' }])),
    templates: {},
    spots: {},
    playlists: {},
    dataSources: {},
    schedule: [],
    defaultPlaylist: 'p',
    ...extra,
  };
}

interface Org {
  seed: SeededOrg;
  credential: string;
  credentialId: string;
}

async function setUp(orgId: string): Promise<Org> {
  const seed = await seedOrg(env.DB, orgId);
  const { credential, secretHash } = await mintCredential(seed.screen);
  const row = await seed.scope.screens.credentials.insert({ screenId: seed.screen, secretHash });
  return { seed, credential, credentialId: row.id };
}

const get = (path: string, credential?: string, headers: Record<string, string> = {}) =>
  exports.default.fetch(`${BASE}${path}`, { headers: { ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...headers } });

let a: Org;
let b: Org;
// Org A: manifest 1 lists blob 1 and a base template's HTML; manifest 2 (desired) lists blob 2 and the weather source.
const M1 = sha('1');
const M2 = sha('2');
const BLOB1 = sha('a');
const BLOB2 = sha('b');
const UNLISTED = sha('c');
const BASE_HTML = sha('e');
const B_BLOB = sha('f');
/** A catalogue brand font: public bytes, kept once under sys/b/. */
const FONT = FONTS[0]!.files[0]!.file;

beforeAll(async () => {
  a = await setUp('dev-a');
  b = await setUp('dev-b');
  const A = a.seed.orgId;

  await env.BLOBS.put(
    manifestKey(A, a.seed.screen, M1),
    JSON.stringify(
      manifest(M1, [BLOB1, BASE_HTML], {
        templates: { 'base/clock@1.0.0': { manifest: {} as never, html: BASE_HTML } },
      }),
    ),
  );
  // Manifest 2 also lists org B's blob: even listed, another org's file is out of reach.
  await env.BLOBS.put(
    manifestKey(A, a.seed.screen, M2),
    JSON.stringify(
      manifest(M2, [BLOB2, B_BLOB, FONT], {
        dataSources: { 'dev-a-source': { id: 'dev-a-source', refreshS: 300 }, 'dev-b-source': { id: 'dev-b-source', refreshS: 300 } },
      }),
    ),
  );
  for (const s of [BLOB1, BLOB2, UNLISTED]) await env.BLOBS.put(orgBlobKey(A, s), `blob ${s.slice(0, 4)}`);
  await env.BLOBS.put(baseBlobKey(BASE_HTML), '<!doctype html>');
  await env.BLOBS.put(baseBlobKey(FONT), 'wOF2 font');
  await env.BLOBS.put(orgBlobKey(b.seed.orgId, B_BLOB), 'org b secret');
  await env.BLOBS.put(manifestKey(b.seed.orgId, b.seed.screen, M1), JSON.stringify(manifest(M1, [B_BLOB])));

  await a.seed.scope.screens.setDesiredManifest(a.seed.screen, M1);
  await a.seed.scope.screens.setDesiredManifest(a.seed.screen, M2);
  await b.seed.scope.screens.setDesiredManifest(b.seed.screen, M1);
});

describe('credential', () => {
  it('round-trips', async () => {
    const { credential } = await mintCredential('scr_abc');
    expect(credential).toMatch(/^sfd_scr_abc\.[A-Za-z0-9_-]{43}$/);
    expect(parseCredential(credential)).toMatchObject({ screenId: 'scr_abc' });
  });
});

describe('device auth', () => {
  it('rejects a request with no token', async () => {
    const res = await get('/manifest.json');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects malformed tokens', async () => {
    const secret = a.credential.slice(a.credential.indexOf('.') + 1);
    for (const auth of [
      `Bearer`,
      `Bearer nope`,
      `Basic ${btoa('a:b')}`,
      `Bearer ${a.credential.slice(4)}`,
      `Bearer sfd_${a.seed.screen}${secret}`,
      `Bearer sfd_.${secret}`,
      `Bearer sfd_${a.seed.screen}.${secret}x`,
      `Bearer sfd_bad/id.${secret}`,
      `Bearer ${a.credential} extra`,
    ]) {
      const res = await exports.default.fetch(`${BASE}/manifest.json`, { headers: { authorization: auth } });
      expect(res.status, auth).toBe(401);
    }
  });

  it('rejects a wrong secret, and a real secret for another screen', async () => {
    const { credential: wrong } = await mintCredential(a.seed.screen);
    expect((await get('/manifest.json', wrong)).status).toBe(401);
    const bSecret = b.credential.slice(b.credential.indexOf('.') + 1);
    expect((await get('/manifest.json', `sfd_${a.seed.screen}.${bSecret}`)).status).toBe(401);
    const { credential: unknown } = await mintCredential('scr_unknown');
    expect((await get('/manifest.json', unknown)).status).toBe(401);
  });

  it('rejects a revoked credential and a revoked screen', async () => {
    const o = await setUp('dev-revoked');
    expect((await get('/manifest.json', o.credential)).status).toBe(404); // authenticated, nothing published
    await o.seed.scope.screens.credentials.update(o.credentialId, { revokedAt: Date.now() });
    expect((await get('/manifest.json', o.credential)).status).toBe(401);

    const p = await setUp('dev-revoked-screen');
    await p.seed.scope.screens.update(p.seed.screen, { status: 'revoked' });
    expect((await get('/manifest.json', p.credential)).status).toBe(401);
  });

  it('accepts the token on the device tree only', async () => {
    // A cookie is not a device credential.
    expect((await get('/manifest.json', undefined, { cookie: 'session=whatever' })).status).toBe(401);
    // And a device credential opens nothing outside /v1/device.
    // The user tree refuses any Authorization header outright (M3-09); elsewhere nothing exists.
    for (const [path, status] of [
      ['/api/screens', 401],
      ['/api/v1/device/manifest.json', 401],
      ['/mcp', 404],
      ['/manifest.json', 404],
    ] as const) {
      const res = await exports.default.fetch(`https://api.test${path}`, { headers: { authorization: `Bearer ${a.credential}` } });
      expect(res.status, path).toBe(status);
    }
  });

  it('answers a CORS preflight without a token', async () => {
    const res = await exports.default.fetch(`${BASE}/manifest.json`, {
      method: 'OPTIONS',
      headers: { origin: 'http://127.0.0.1:8090', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization,if-none-match' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toMatch(/authorization/);
  });
});

describe('GET /v1/device/manifest.json', () => {
  it("returns the screen's desired manifest, with its id as the ETag", async () => {
    const res = await get('/manifest.json', a.credential);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe(`"${M2}"`);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(((await res.json()) as ScreenManifest).id).toBe(M2);
  });

  it('returns 304 when If-None-Match names it', async () => {
    for (const inm of [`"${M2}"`, `W/"${M2}"`, `"${M1}", "${M2}"`, '*']) {
      const res = await get('/manifest.json', a.credential, { 'if-none-match': inm });
      expect(res.status, inm).toBe(304);
      expect(res.headers.get('etag')).toBe(`"${M2}"`);
      expect(await res.text()).toBe('');
    }
    expect((await get('/manifest.json', a.credential, { 'if-none-match': `"${M1}"` })).status).toBe(200);
  });

  it('is a JSON 404 before anything is published', async () => {
    const o = await setUp('dev-empty');
    const res = await get('/manifest.json', o.credential);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });
});

describe('GET /v1/device/blobs/:sha256', () => {
  it('streams a blob the desired manifest lists, cached forever', async () => {
    const res = await get(`/blobs/${BLOB2}`, a.credential);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(await res.text()).toBe('blob bbbb');
  });

  it('serves the previous manifest too, and a base template from the shared prefix', async () => {
    expect(await (await get(`/blobs/${BLOB1}`, a.credential)).text()).toBe('blob aaaa');
    expect(await (await get(`/blobs/${BASE_HTML}`, a.credential)).text()).toBe('<!doctype html>');
  });

  it('never lets a blob run as a page on the API origin', async () => {
    const html = await get(`/blobs/${BASE_HTML}`, a.credential);
    expect(html.headers.get('content-type')).toBe('text/html');
    expect(html.headers.get('x-content-type-options')).toBe('nosniff');
    expect(html.headers.get('content-security-policy')).toMatch(/^sandbox; default-src 'none'/);
    expect(html.headers.get('content-disposition')).toBe('attachment');
    const png = await get(`/blobs/${BLOB2}`, a.credential);
    expect(png.headers.get('x-content-type-options')).toBe('nosniff');
    expect(png.headers.get('content-security-policy')).toMatch(/^sandbox; default-src 'none'/);
    expect(png.headers.get('content-disposition')).toBeNull();
  });

  it('serves a catalogue brand font from the shared prefix, only to a screen whose manifest lists it', async () => {
    expect(await (await get(`/blobs/${FONT}`, a.credential)).text()).toBe('wOF2 font');
    expect((await get(`/blobs/${FONT}`, b.credential)).status).toBe(404);
  });

  it("is a 404 for another org's blob, even one the manifest lists", async () => {
    expect((await get(`/blobs/${B_BLOB}`, a.credential)).status).toBe(404);
    // Org B can fetch it.
    expect(await (await get(`/blobs/${B_BLOB}`, b.credential)).text()).toBe('org b secret');
    // And org B cannot fetch org A's.
    expect((await get(`/blobs/${BLOB2}`, b.credential)).status).toBe(404);
  });

  it('is a 404 for a blob no current or previous manifest lists', async () => {
    const res = await get(`/blobs/${UNLISTED}`, a.credential);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'file not found' });
    expect((await get('/blobs/not-a-hash', a.credential)).status).toBe(404);
  });

  it('stops serving a manifest two publishes back', async () => {
    const o = await setUp('dev-rollover');
    const ids = [sha('3'), sha('4'), sha('5')];
    const blobs = [sha('6'), sha('7'), sha('8')];
    for (let i = 0; i < 3; i++) {
      await env.BLOBS.put(manifestKey(o.seed.orgId, o.seed.screen, ids[i]!), JSON.stringify(manifest(ids[i]!, [blobs[i]!])));
      await env.BLOBS.put(orgBlobKey(o.seed.orgId, blobs[i]!), `v${i}`);
      await o.seed.scope.screens.setDesiredManifest(o.seed.screen, ids[i]!);
    }
    expect((await get(`/blobs/${blobs[0]}`, o.credential)).status).toBe(404);
    expect((await get(`/blobs/${blobs[1]}`, o.credential)).status).toBe(200);
    expect((await get(`/blobs/${blobs[2]}`, o.credential)).status).toBe(200);
  });
});

describe('GET /v1/device/data/:id.json', () => {
  it('returns the latest snapshot of a source the manifest lists', async () => {
    await scoped(env.DB, a.seed.orgId).dataSources.putSnapshot('dev-a-source', { version: 'v2', fetchedAt: Date.UTC(2026, 10, 17, 14), dataJson: '{"t":14}' });
    const res = await get('/data/dev-a-source.json', a.credential);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ id: 'dev-a-source', version: Date.UTC(2026, 10, 17, 14), fetchedAt: '2026-11-17T14:00:00.000Z', data: { t: 14 } });
  });

  it("is a 404 for a source the manifest does not list, or another org's", async () => {
    // Org B's own manifest lists no sources.
    expect((await get('/data/dev-b-source.json', b.credential)).status).toBe(404);
    // Org A's manifest names org B's source id, but the snapshot lookup is scoped to org A.
    expect((await get('/data/dev-b-source.json', a.credential)).status).toBe(404);
    expect((await get('/data/nope.json', a.credential)).status).toBe(404);
    expect((await get('/data/dev-a-source', a.credential)).status).toBe(404);
  });
});
