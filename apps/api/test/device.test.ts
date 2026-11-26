// The device tree against local D1 and R2: credentials, the three content routes, and what a
// screen may not reach.
import { MANIFEST_SCHEMA, type ScreenManifest } from '@signforge/contract';
import { scoped } from '@signforge/db';
import { seedOrg, seedPlayerRelease, testScope, type SeededOrg } from '@signforge/db/testing';
import { env, exports } from 'cloudflare:workers';
import { FONTS } from '@signforge/compiler';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintCredential, parseCredential } from '../src/device/credential';
import { feedBlobKey } from '../src/data/feed-photos';
import { baseBlobKey, manifestKey, orgBlobKey, playerReleaseKey } from '../src/r2';
import { device } from '../src/device';
import { counted } from './counting';

const BASE = 'https://api.test/v1/device';
const sha = (c: string) => c.repeat(64);

/** Enough of a manifest for the routes: they read its files, templates and data sources. */
function manifest(id: string, files: string[], extra: Partial<ScreenManifest> = {}): ScreenManifest {
  return {
    schema: MANIFEST_SCHEMA,
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
      ['/manifest.json', 404],
    ] as const) {
      const res = await exports.default.fetch(`https://api.test${path}`, { headers: { authorization: `Bearer ${a.credential}` } });
      expect(res.status, path).toBe(status);
    }
    // The agents' tree (M4-06) takes only an agent's OAuth token.
    const mcp = await exports.default.fetch('https://api.test/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${a.credential}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get('www-authenticate')).toContain('error="invalid_token"');
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

  it('serves the files of the last good manifest the screen reports, however many publishes back, but not its feeds', async () => {
    const o = await setUp('dev-last-good');
    const ids = [sha('3'), sha('4'), sha('5')];
    const blobs = [sha('6'), sha('7'), sha('8')];
    // A, the last good manifest, binds a feed that B and C dropped.
    const feed = { 'dev-last-good-source': { id: 'dev-last-good-source', refreshS: 300 } };
    for (let i = 0; i < 3; i++) {
      await env.BLOBS.put(
        manifestKey(o.seed.orgId, o.seed.screen, ids[i]!),
        JSON.stringify(manifest(ids[i]!, [blobs[i]!], i === 0 ? { dataSources: feed } : {})),
      );
      await env.BLOBS.put(orgBlobKey(o.seed.orgId, blobs[i]!), `v${i}`);
      await o.seed.scope.screens.setDesiredManifest(o.seed.screen, ids[i]!);
    }
    await o.seed.scope.dataSources.putSnapshot('dev-last-good-source', {
      version: 'v1',
      fetchedAt: Date.now(),
      checkedAt: Date.now(),
      dataJson: '{"after":"removal"}',
    });
    // A sibling screen in the same org, with its own manifest and a file the org holds.
    const sibling = await o.seed.scope.screens.insert({ name: 'Sibling', timezone: 'UTC', orientation: 'landscape' });
    const [siblingManifest, siblingBlob] = [sha('9'), sha('d')];
    await env.BLOBS.put(manifestKey(o.seed.orgId, sibling.id, siblingManifest), JSON.stringify(manifest(siblingManifest, [siblingBlob])));
    await env.BLOBS.put(orgBlobKey(o.seed.orgId, siblingBlob), 'sibling');
    await o.seed.scope.screens.setDesiredManifest(sibling.id, siblingManifest);

    const syncReporting = async (lastGood: string) => {
      const res = await exports.default.fetch(`${BASE}/sync`, {
        method: 'POST',
        headers: { authorization: `Bearer ${o.credential}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          seq: 0,
          epoch: 'ep1',
          player: { version: '2.0.0', manifestSchemas: [2], protocols: [1, 2] },
          manifest: { active: lastGood, filesMissing: 0, fallbackFrom: ids[2], lastGood },
          display: { on: true },
          deviceTime: new Date().toISOString(),
          clock: { offsetMs: 0, trusted: true },
          playCounts: [],
          snapshots: {},
        }),
      });
      expect(res.status).toBe(200);
    };
    // Published A, then B and C, which played nothing: the screen went back to A.
    await syncReporting(ids[0]!);
    expect(await (await get(`/blobs/${blobs[0]}`, o.credential)).text()).toBe('v0');
    // A file is fixed by its hash; a feed is not. Its latest snapshot is from after A was replaced.
    expect((await get('/data/dev-last-good-source.json', o.credential)).status).toBe(404);
    // Another screen's manifest, reported as last good, opens nothing, in the same org or another.
    await syncReporting(siblingManifest);
    expect((await get(`/blobs/${siblingBlob}`, o.credential)).status).toBe(404);
    await syncReporting(M1);
    expect((await get(`/blobs/${BLOB1}`, o.credential)).status).toBe(404);
    expect((await get(`/blobs/${blobs[0]}`, o.credential)).status).toBe(404);
  });

  it('serves feed image blobs only from this org when referenced by a snapshot of a bound list-image source (#196)', async () => {
    const o = await setUp('dev-feed-a');
    const other = await setUp('dev-feed-b');
    const [feedFile, feedThumb, otherSrcBlob, otherOrgBlob, plainBlob] = [sha('1'), sha('2'), sha('3'), sha('4'), sha('5')];
    const src = o.seed.dataSource;
    const otherSrc = (await o.seed.scope.dataSources.insert({ name: 'Unbound news', format: 'rss', urlEncrypted: 'enc:u', refreshS: 300 })).id;

    const newsTpl = (withImage: boolean) => ({
      html: BASE_HTML,
      manifest: {
        id: 'news',
        version: withImage ? '2.0.0' : '1.4.1',
        name: 'News',
        fields: {
          items: {
            type: 'list' as const,
            label: 'Headlines',
            default: [],
            item: {
              title: { type: 'text' as const, label: 'Title' },
              ...(withImage ? { image: { type: 'image' as const, label: 'Photo' } } : {}),
            },
          },
        },
        duration: { defaultMs: 10_000, minMs: 4000, maxMs: 60_000 },
        orientations: ['landscape' as const],
        uses: [],
        background: '#000',
        protocol: 2,
      },
    });

    const mImg = sha('a');
    await env.BLOBS.put(
      manifestKey(o.seed.orgId, o.seed.screen, mImg),
      JSON.stringify(
        manifest(mImg, [BASE_HTML], {
          templates: { 'base/news@2.0.0': newsTpl(true) },
          spots: {
            n: {
              id: 'n',
              name: 'News',
              kind: 'template',
              template: 'base/news@2.0.0',
              durationMs: 10_000,
              data: { items: [] },
              assets: {},
              bindings: { items: { source: src, path: 'items' } },
            },
          },
          dataSources: { [src]: { id: src, refreshS: 300 } },
        }),
      ),
    );
    await o.seed.scope.screens.setDesiredManifest(o.seed.screen, mImg);

    await o.seed.scope.dataSources.putSnapshot(src, {
      version: 'v1',
      fetchedAt: Date.now(),
      checkedAt: Date.now(),
      dataJson: JSON.stringify({
        items: [
          { title: 'Story 1', image: { file: feedFile, thumb: feedThumb } },
          // Even if a snapshot names another org's hash, feedBlobKey reads only this org's prefix.
          { title: 'Cross-org', image: { file: otherOrgBlob, thumb: otherOrgBlob } },
        ],
      }),
    });
    await o.seed.scope.dataSources.putSnapshot(otherSrc, {
      version: 'v1',
      fetchedAt: Date.now(),
      checkedAt: Date.now(),
      dataJson: JSON.stringify({ items: [{ title: 'Other source', image: { file: otherSrcBlob, thumb: otherSrcBlob } }] }),
    });
    await env.BLOBS.put(feedBlobKey(o.seed.orgId, feedFile), 'jpeg-lead', { httpMetadata: { contentType: 'image/jpeg' } });
    await env.BLOBS.put(feedBlobKey(o.seed.orgId, feedThumb), 'webp-thumb', { httpMetadata: { contentType: 'image/webp' } });
    await env.BLOBS.put(feedBlobKey(o.seed.orgId, otherSrcBlob), 'other-source-blob', { httpMetadata: { contentType: 'image/jpeg' } });
    await env.BLOBS.put(feedBlobKey(other.seed.orgId, otherOrgBlob), 'other-org-secret', { httpMetadata: { contentType: 'image/jpeg' } });
    // Stored under orgBlobKey (not feedBlobKey) and unlisted in manifest.files: must NOT be served via feed path.
    await env.BLOBS.put(orgBlobKey(o.seed.orgId, plainBlob), 'org-asset-not-feed');

    const lead = await get(`/blobs/${feedFile}`, o.credential);
    expect(lead.status).toBe(200);
    expect(lead.headers.get('content-type')).toBe('image/jpeg');
    expect(lead.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(lead.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await lead.text()).toBe('jpeg-lead');

    const thumb = await get(`/blobs/${feedThumb}`, o.credential);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('content-type')).toBe('image/webp');
    expect(await thumb.text()).toBe('webp-thumb');

    // Another source in the same org (not in this screen's manifest): 404.
    expect((await get(`/blobs/${otherSrcBlob}`, o.credential)).status).toBe(404);
    // Another org's feed blob: 404, even when referenced by hash in this org's snapshot.
    expect((await get(`/blobs/${otherOrgBlob}`, o.credential)).status).toBe(404);
    // Another org's screen cannot read org A's feed blob.
    expect((await get(`/blobs/${feedFile}`, other.credential)).status).toBe(404);

    // A text-only template (news 1.4.1) cannot fetch feed blobs even when its source's snapshot holds them.
    const oPlain = await setUp('dev-feed-plain');
    const plainSrc = oPlain.seed.dataSource;
    const mPlain = sha('b');
    await env.BLOBS.put(
      manifestKey(oPlain.seed.orgId, oPlain.seed.screen, mPlain),
      JSON.stringify(
        manifest(mPlain, [BASE_HTML], {
          templates: { 'base/news@1.4.1': newsTpl(false) },
          spots: {
            n: {
              id: 'n',
              name: 'News',
              kind: 'template',
              template: 'base/news@1.4.1',
              durationMs: 10_000,
              data: { items: [] },
              assets: {},
              bindings: { items: { source: plainSrc, path: 'items' } },
            },
          },
          dataSources: { [plainSrc]: { id: plainSrc, refreshS: 300 } },
        }),
      ),
    );
    await oPlain.seed.scope.screens.setDesiredManifest(oPlain.seed.screen, mPlain);
    await oPlain.seed.scope.dataSources.putSnapshot(plainSrc, {
      version: 'v1',
      fetchedAt: Date.now(),
      checkedAt: Date.now(),
      dataJson: JSON.stringify({ items: [{ title: 'Story', image: { file: feedFile, thumb: feedThumb } }] }),
    });
    await env.BLOBS.put(feedBlobKey(oPlain.seed.orgId, feedFile), 'jpeg-lead', { httpMetadata: { contentType: 'image/jpeg' } });
    expect((await get(`/blobs/${feedFile}`, oPlain.credential)).status).toBe(404);
  });
});

describe('GET /v1/device/data/:id.json', () => {
  it('returns the latest snapshot of a source the manifest lists', async () => {
    await scoped(env.DB, a.seed.orgId).dataSources.putSnapshot('dev-a-source', {
      version: 'v2',
      fetchedAt: Date.UTC(2026, 10, 17, 14),
      checkedAt: Date.UTC(2026, 10, 17, 14),
      dataJson: '{"t":14}',
    });
    const res = await get('/data/dev-a-source.json', a.credential);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      id: 'dev-a-source',
      version: Date.UTC(2026, 10, 17, 14),
      fetchedAt: '2026-11-17T14:00:00.000Z',
      checkedAt: '2026-11-17T14:00:00.000Z',
      data: { t: 14 },
    });
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

// #628: a device supervisor asks for its screen's channel's release, and fetches its tarball by hash. The channel is
// the screen's own, read with its credential; a tarball comes only from the release prefix, and only for a release
// the channel is offered.
describe('player releases (#628)', () => {
  const STABLE = sha('5');
  const CANARY = sha('7');
  const UNREGISTERED = sha('9');
  const SIGNED = (version: number, tarball: string) =>
    JSON.stringify({
      version,
      sha256: tarball,
      size: 4,
      files: [{ path: 'index.html', sha256: sha('d') }],
      manifestSchemas: [MANIFEST_SCHEMA],
      protocols: [1, 2],
      createdAt: '2026-11-26T12:00:00.000Z',
    });
  const offerFor = async (credential: string) => {
    const res = await get('/player-release', credential);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    return res.json();
  };

  it('offers nothing before any release, with the schema the server compiles', async () => {
    expect(await offerFor(a.credential)).toEqual({ manifestSchema: MANIFEST_SCHEMA, channel: 'stable', release: null });
  });

  it('offers a stable screen the newest promoted release, and a canary screen the newest of all, as CI signed it', async () => {
    await seedPlayerRelease(env.DB, {
      version: 5,
      sha256: STABLE,
      size: 4,
      manifest: SIGNED(5, STABLE),
      signature: 'c2lnLTU=',
      channel: 'stable',
      promotedAt: 1,
    });
    await seedPlayerRelease(env.DB, { version: 7, sha256: CANARY, size: 4, manifest: SIGNED(7, CANARY), signature: 'c2lnLTc=', channel: 'canary' });
    // The release prefix only: a tarball's hash names no other key.
    await env.BLOBS.put(playerReleaseKey(STABLE), 'tar5', { httpMetadata: { contentType: 'application/gzip' } });
    await env.BLOBS.put(playerReleaseKey(CANARY), 'tar7');
    await env.BLOBS.put(playerReleaseKey(UNREGISTERED), 'tar9');
    await testScope(env.DB, b.seed.orgId).screens.update(b.seed.screen, { playerChannel: 'canary' });
    expect(await offerFor(a.credential)).toEqual({
      manifestSchema: MANIFEST_SCHEMA,
      channel: 'stable',
      release: { manifest: SIGNED(5, STABLE), signature: 'c2lnLTU=' },
    });
    expect(await offerFor(b.credential)).toEqual({
      manifestSchema: MANIFEST_SCHEMA,
      channel: 'canary',
      release: { manifest: SIGNED(7, CANARY), signature: 'c2lnLTc=' },
    });
  });

  it("streams a release's tarball to a screen whose channel is offered it, and nothing else", async () => {
    const fetched = async (credential: string, hash: string) => {
      const res = await get(`/player-release/${hash}`, credential);
      return res.status === 200 ? `200 ${await res.text()} ${res.headers.get('content-type')}` : String(res.status);
    };
    expect(await fetched(a.credential, STABLE)).toBe('200 tar5 application/gzip');
    expect(await fetched(b.credential, STABLE)).toBe('200 tar5 application/gzip');
    expect(await fetched(b.credential, CANARY)).toBe('200 tar7 application/gzip');
    // A canary build is never a stable screen's, though the screen knows its hash.
    expect(await fetched(a.credential, CANARY)).toBe('404');
    // In R2 under the prefix, but no release names it; another prefix's object; not a hash at all.
    expect(await fetched(b.credential, UNREGISTERED)).toBe('404');
    expect(await fetched(a.credential, BLOB2)).toBe('404');
    expect(await fetched(a.credential, '..%2Fb%2Fx')).toBe('404');
  });

  it('asks for the credential, as every device route does', async () => {
    expect((await get('/player-release')).status).toBe(401);
    expect((await get(`/player-release/${STABLE}`)).status).toBe(401);
  });

  it('costs one D1 query more than the credential check, and writes nothing, polled every 15 minutes', async () => {
    const cost = async (path: string) => {
      const { result, bindings } = counted();
      await device.request(path, { headers: { authorization: `Bearer ${a.credential}` } }, bindings);
      return result();
    };
    // A credential's first use is marked once, ever (`markUsed`): spent here, so what is pinned is every later poll.
    await get('/player-release', a.credential);
    // Measured, as the most each may take: the credential's screen, its channel with it, then the release. No write, so
    // a fleet's polls cost the Free plan's 100,000 daily writes nothing.
    expect({ offer: await cost('/player-release'), tarball: await cost(`/player-release/${STABLE}`) }).toEqual({
      offer: { statements: 2, queries: 2, rpcs: [] },
      tarball: { statements: 2, queries: 2, rpcs: [] },
    });
  });
});
