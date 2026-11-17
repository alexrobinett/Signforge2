import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreenManifest } from '@signforge/contract';
import { DeviceCredential } from './credential';
import { PinSet, UnauthorisedError, loadActiveManifest, sync } from './store';

// ---------------------------------------------------------------- fakes
/** Cache Storage in memory: enough of it for the store. */
class FakeCache {
  readonly entries = new Map<string, { body: ArrayBuffer; type: string }>();
  private key = (k: string) => new URL(k, 'http://player.test').href;
  async match(k: string) {
    const e = this.entries.get(this.key(k));
    return e ? new Response(e.body.slice(0), { headers: { 'content-type': e.type } }) : undefined;
  }
  async put(k: string, res: Response) {
    this.entries.set(this.key(k), { body: await res.arrayBuffer(), type: res.headers.get('content-type') ?? '' });
  }
  async delete(k: string) {
    return this.entries.delete(this.key(k));
  }
  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
}
let stores: Map<string, FakeCache>;
const open = (name: string) => {
  let c = stores.get(name);
  if (!c) stores.set(name, (c = new FakeCache()));
  return c;
};

const sha = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const FILES = { a: 'file a', b: 'file b' };
const A = await sha(FILES.a);
const B = await sha(FILES.b);
const blobPath = { [`/blobs/${A}`]: FILES.a, [`/blobs/${B}`]: FILES.b };

function manifest(id: string, text = 'hello'): ScreenManifest {
  return {
    schema: 2,
    id,
    generatedAt: '2026-11-17T00:00:00Z',
    screen: { id: 's1', name: 'Counter', timezone: 'UTC', orientation: 'landscape' },
    files: { [A]: { size: 6, type: 'image/png' }, [B]: { size: 6, type: 'image/png' } },
    templates: {},
    spots: {
      a: { id: 'a', name: text, kind: 'image', file: A, fit: 'cover', durationMs: 5000 },
      b: { id: 'b', name: 'b', kind: 'image', file: B, fit: 'cover', durationMs: 5000 },
    },
    playlists: { all: { id: 'all', name: 'All', transition: { type: 'fade', ms: 600 }, items: [{ spot: 'a' }, { spot: 'b' }] } },
    dataSources: {},
    schedule: [],
    defaultPlaylist: 'all',
  };
}

/** A device API stand-in: the screen's desired manifest, its files, a credential, ETags. */
const api = {
  manifest: manifest('m1'),
  credential: 'sfd_scr_1.secret',
  requests: [] as { url: string; headers: Headers }[],
};
const BASE = 'http://api.test/v1/device';

async function handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const headers = new Headers(init?.headers);
  api.requests.push({ url, headers });
  if (headers.get('authorization') !== `Bearer ${api.credential}`) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const path = url.slice(BASE.length);
  if (path === '/manifest.json') {
    const etag = `"${api.manifest.id}"`;
    if (headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
    return new Response(JSON.stringify(api.manifest), { headers: { etag, 'content-type': 'application/json' } });
  }
  const body = blobPath[path];
  return body ? new Response(body) : new Response('not found', { status: 404 });
}

const auth = { authorization: `Bearer ${api.credential}` };
const manifestRequests = () => api.requests.filter((r) => r.url.endsWith('/manifest.json'));
const blobRequests = () => api.requests.filter((r) => r.url.includes('/blobs/'));

beforeEach(() => {
  stores = new Map();
  api.manifest = manifest('m1');
  api.requests = [];
  vi.stubGlobal('caches', { open: async (name: string) => open(name) });
  vi.stubGlobal('fetch', vi.fn(handle));
});

// ---------------------------------------------------------------- tests
describe('sync against the device API', () => {
  it('downloads, verifies and activates a first manifest, sending the credential on every request', async () => {
    const r = await sync(BASE, { headers: auth });
    expect(r).toMatchObject({ changed: true, downloaded: 2 });
    expect((await loadActiveManifest())?.id).toBe('m1');
    expect(api.requests).toHaveLength(3);
    for (const req of api.requests) expect(req.headers.get('authorization')).toBe(auth.authorization);
    // Nothing to compare against yet.
    expect(manifestRequests()[0]!.headers.get('if-none-match')).toBeNull();
  });

  it('sends If-None-Match with the current manifest id; a 304 with every file held downloads nothing', async () => {
    await sync(BASE, { headers: auth });
    api.requests = [];
    const r = await sync(BASE, { currentId: 'm1', headers: auth });
    expect(r).toEqual({ changed: false, downloaded: 0 });
    expect(manifestRequests()[0]!.headers.get('if-none-match')).toBe('"m1"');
    expect(blobRequests()).toHaveLength(0);
  });

  it('on a 304 still fetches back files missing from the cache, using the cached manifest', async () => {
    await sync(BASE, { headers: auth });
    await open('sf-blobs-v1').delete(`/_sf/blob/${B}`); // evicted under storage pressure
    api.requests = [];
    const r = await sync(BASE, { currentId: 'm1', headers: auth });
    expect(r).toEqual({ changed: false, downloaded: 1 });
    expect(manifestRequests()).toHaveLength(1);
    expect(blobRequests().map((q) => q.url)).toEqual([`${BASE}/blobs/${B}`]);
    expect(await (await open('sf-blobs-v1').match(`/_sf/blob/${B}`))!.text()).toBe(FILES.b);
  });

  it('asks again without the condition if a 304 arrives but the cached manifest is gone', async () => {
    await sync(BASE, { headers: auth });
    stores.delete('sf-state-v1');
    api.requests = [];
    const r = await sync(BASE, { currentId: 'm1', headers: auth });
    expect(r).toEqual({ changed: false, downloaded: 0 });
    expect(manifestRequests().map((q) => q.headers.get('if-none-match'))).toEqual(['"m1"', null]);
  });

  it('picks up a new manifest after a 304 and switches to it in one step', async () => {
    await sync(BASE, { headers: auth });
    api.manifest = manifest('m2', 'changed text');
    const r = await sync(BASE, { currentId: 'm1', headers: auth });
    expect(r.changed).toBe(true);
    expect(r.manifest?.spots.a?.name).toBe('changed text');
    expect((await loadActiveManifest())?.id).toBe('m2');
  });

  it('a 401 is UnauthorisedError, not a network failure, and leaves the active manifest alone', async () => {
    await sync(BASE, { headers: auth });
    const err = await sync(BASE, { currentId: 'm1', headers: { authorization: 'Bearer sfd_scr_1.revoked' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorisedError);
    expect((await loadActiveManifest())?.id).toBe('m1');
  });

  it('a 401 on a file is UnauthorisedError too, and nothing is activated', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes('/blobs/') ? Response.json({ error: 'unauthorized' }, { status: 401 }) : handle(input, init),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(sync(BASE, { headers: auth })).rejects.toBeInstanceOf(UnauthorisedError);
    expect(await loadActiveManifest()).toBeUndefined();
  });

  it('a network failure stays an ordinary error (offline)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const err = await sync(BASE, { headers: auth }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(UnauthorisedError);
  });
});

describe('file cleanup and pins', () => {
  const held = async () => (await open('sf-blobs-v1').keys()).map((k) => k.url.split('/').pop());
  /** m1 without spot b, so file B is no longer needed. */
  const withoutB = (id: string): ScreenManifest => {
    const m = manifest(id);
    delete m.spots.b;
    delete m.files[B];
    m.playlists.all!.items = [{ spot: 'a' }];
    return m;
  };

  it('keeps a pinned file the new manifest no longer needs, and drops it once unpinned', async () => {
    await sync(BASE, { headers: auth });
    api.manifest = withoutB('m2');
    const pins = new PinSet();
    pins.hold('preparing', [B]);
    await sync(BASE, { currentId: 'm1', headers: auth, pinned: pins });
    expect(await held()).toEqual(expect.arrayContaining([A, B]));

    pins.release('preparing');
    await sync(BASE, { currentId: 'm2', headers: auth, pinned: pins });
    expect(await held()).toEqual([A]);
  });

  it('pins from several holders add up, and a holder replaces its own pins', () => {
    const pins = new PinSet();
    pins.hold('playing', [A]);
    pins.hold('last-known-good', [A, B]);
    pins.hold('playing', []);
    expect([...pins].sort()).toEqual([A, B].sort());
    pins.release('last-known-good');
    expect([...pins]).toEqual([]);
  });

  it('never stores a file whose hash does not match, and activates nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => (String(input).endsWith(`/blobs/${B}`) ? new Response('not file b') : handle(input, init))),
    );
    await expect(sync(BASE, { headers: auth })).rejects.toThrow(`file ${B.slice(0, 12)}: failed verification`);
    expect(await held()).not.toContain(B);
    expect((await open('sf-blobs-v1').keys()).every((k) => k.url.includes('/_sf/blob/'))).toBe(true);
    expect(await loadActiveManifest()).toBeUndefined();
  });
});

describe('DeviceCredential', () => {
  it('collects the credential from the supervisor once and sends it as a bearer header', async () => {
    const f = vi.fn(async () => Response.json({ credential: 'sfd_scr_1.secret' }));
    const c = new DeviceCredential('http://127.0.0.1:8091', f);
    expect(await c.headers()).toEqual({ authorization: 'Bearer sfd_scr_1.secret' });
    expect(await c.headers()).toEqual({ authorization: 'Bearer sfd_scr_1.secret' });
    expect(f).toHaveBeenCalledTimes(1);
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe('http://127.0.0.1:8091/credential');
  });

  it('sends nothing while the supervisor has none, and asks again after forget()', async () => {
    const f = vi.fn(async () => Response.json({ error: 'no credential' }, { status: 404 }));
    const c = new DeviceCredential('http://127.0.0.1:8091', f);
    expect(await c.headers()).toEqual({});
    f.mockImplementation(async () => Response.json({ credential: 'sfd_scr_1.new' }));
    expect(await c.headers()).toEqual({ authorization: 'Bearer sfd_scr_1.new' });
    c.forget();
    expect(c.held).toBe(false);
    await c.headers();
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('treats an unreachable supervisor as no credential', async () => {
    const c = new DeviceCredential(
      'http://127.0.0.1:8091',
      vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))),
    );
    expect(await c.headers()).toEqual({});
  });
});
