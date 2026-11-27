import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MANIFEST_SCHEMA, type ScreenManifest } from '@signforge/contract';
import { DeviceCredential } from './credential';
import { FEED_IMAGE_MAX_BYTES } from './download';
import { PinSet, UnauthorisedError, heldBlobs, loadActiveManifest, storeFrames, storedFrames, sync, syncFeedImages, wipeContent } from './store';

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
    schema: MANIFEST_SCHEMA,
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
  vi.stubGlobal('caches', { open: async (name: string) => open(name), delete: async (name: string) => stores.delete(name) });
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

  it('asks again without the condition, and stores a sound copy, if the cached manifest is damaged', async () => {
    await sync(BASE, { headers: auth });
    await open('sf-state-v1').put('/_sf/manifest/active', new Response('{"id": "m1", "tor'));
    api.requests = [];
    const r = await sync(BASE, { currentId: 'm1', headers: auth });
    expect(r).toEqual({ changed: false, downloaded: 0 });
    expect(manifestRequests().map((q) => q.headers.get('if-none-match'))).toEqual(['"m1"', null]);
    expect((await loadActiveManifest())?.id).toBe('m1');
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

  it('keeps contained frames for the next page load, and drops them with their bundle or when another player made them (#232)', async () => {
    await sync(BASE, { headers: auth });
    await storeFrames(A, { wrapper: 'wrapper a', template: 'template a' });
    await storeFrames(B, { wrapper: 'wrapper b', template: 'template b' });
    // What an earlier player version kept for the same bundle.
    await open('sf-frames-v1').put(`/_sf/frames/0.0.0%2Bolder/${A}`, Response.json({ wrapper: 'old', template: 'old' }));
    expect(await storedFrames(A)).toEqual({ wrapper: 'wrapper a', template: 'template a' });

    api.manifest = withoutB('m2');
    await sync(BASE, { currentId: 'm1', headers: auth });
    expect(await storedFrames(A)).toEqual({ wrapper: 'wrapper a', template: 'template a' });
    expect(await storedFrames(B)).toBeUndefined();
    expect((await open('sf-frames-v1').keys()).map((k) => new URL(k.url).pathname)).toEqual([`/_sf/frames/0.0.0%2Btest%2B0/${A}`]);
  });

  it('never fails a sync for a frames cache it cannot list: it drops the cache instead (#232)', async () => {
    await storeFrames(A, { wrapper: 'w', template: 't' });
    open('sf-frames-v1').keys = async () => {
      throw new Error('quota');
    };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(sync(BASE, { headers: auth })).resolves.toMatchObject({ changed: true });
    expect((await loadActiveManifest())?.id).toBe('m1');
    expect(stores.has('sf-frames-v1')).toBe(false);
  });

  it('wipes kept frames with the rest of the content (#232)', async () => {
    await storeFrames(A, { wrapper: 'w', template: 't' });
    await wipeContent();
    expect(await storedFrames(A)).toBeUndefined();
  });

  it('reads no frames from an entry that is not what it keeps, so the bundle is contained again (#232)', async () => {
    const at = `/_sf/frames/0.0.0%2Btest%2B0/${A}`;
    await open('sf-frames-v1').put(at, Response.json({ wrapper: 1, template: 'only one' }));
    expect(await storedFrames(A)).toBeUndefined();
    await open('sf-frames-v1').put(at, new Response('not json'));
    await expect(storedFrames(A)).rejects.toThrow();
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

  it('fetches only missing feed images best-effort, keeps those a pin holds, and drops them once unpinned (#196)', async () => {
    const F1 = await sha('feed photo 1');
    const F2 = await sha('feed photo 2');
    const MISSING = '0'.repeat(64);
    const CORRUPT = '9'.repeat(64);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith(`/blobs/${F1}`)) return new Response('feed photo 1', { headers: { 'content-type': 'image/jpeg' } });
        if (url.endsWith(`/blobs/${F2}`)) return new Response('feed photo 2', { headers: { 'content-type': 'image/webp' } });
        if (url.endsWith(`/blobs/${CORRUPT}`)) return new Response('corrupt bytes', { headers: { 'content-type': 'image/jpeg' } });
        return handle(input, init);
      }),
    );
    api.manifest = withoutB('m1');
    await sync(BASE, { headers: auth });
    const pins = new PinSet();
    pins.hold('snapshots', [F1, F2]);

    expect(await syncFeedImages(BASE, [F1, MISSING, CORRUPT, F2, F1], { headers: auth, pinned: pins })).toBe(false);
    expect(await heldBlobs([F1, F2, MISSING, CORRUPT])).toEqual([F1, F2]);
    // The type the server stored it with.
    expect((await open('sf-blobs-v1').match(`/_sf/blob/${F1}`))?.headers.get('content-type')).toBe('image/jpeg');
    // Held already: not asked for again.
    api.requests = [];
    await syncFeedImages(BASE, [F1, F2], { headers: auth, pinned: pins });
    expect(blobRequests()).toEqual([]);

    // The snapshot moves on to F2 while the spot playing still shows F1.
    pins.hold('snapshots', [F2]);
    pins.hold('playing', [F1]);
    expect(await syncFeedImages(BASE, [], { pinned: pins })).toBe(true);
    expect(await heldBlobs([F1, F2])).toEqual([F1, F2]);
    pins.release('playing');
    expect(await syncFeedImages(BASE, [], { pinned: pins })).toBe(true);
    expect(await heldBlobs([F1, F2])).toEqual([F2]);
    pins.hold('snapshots', []);
    expect(await syncFeedImages(BASE, [], { pinned: pins })).toBe(false);
    expect(await heldBlobs([F1, F2])).toEqual([]);
    // The active manifest's own file stays throughout.
    expect(await held()).toEqual([A]);
  });

  it('cleans up against the synced manifest, which while falling back is not the one playing (#196)', async () => {
    await sync(BASE, { headers: auth });
    // Nothing pins m1's files: the screen plays another manifest, whose own files `last-good` holds.
    await syncFeedImages(BASE, [], { pinned: new PinSet() });
    expect((await held()).sort()).toEqual([A, B].sort());
  });

  it('takes turns with a sync, so a feed-image pass never deletes the files of a manifest downloading (#196)', async () => {
    const C = await sha('file c');
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    let reachedB = () => {};
    const atB = new Promise<void>((r) => (reachedB = r));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith(`/blobs/${C}`)) return new Response('file c');
        if (url.endsWith(`/blobs/${B}`)) {
          reachedB();
          await held;
        }
        return handle(input, init);
      }),
    );
    // m1 needs only C; m2 needs A and B, which it downloads in that order.
    const m1 = withoutB('m1');
    m1.files = { [C]: { size: 6, type: 'image/png' } };
    m1.spots.a = { id: 'a', name: 'c', kind: 'image', file: C, fit: 'cover', durationMs: 5000 };
    api.manifest = m1;
    await sync(BASE, { headers: auth });
    api.manifest = manifest('m2');

    const order: string[] = [];
    const syncing = sync(BASE, { currentId: 'm1', headers: auth }).then(() => order.push('sync'));
    await atB; // A is stored, B is on its way, and m1 is still the active manifest.
    const feed = syncFeedImages(BASE, [], { pinned: new PinSet() }).then(() => order.push('feed'));
    // Let every job already queued run (the fake cache does no I/O), so a pass that did not wait would have cleaned up by now.
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual([]);
    release();
    await Promise.all([syncing, feed]);
    expect(order).toEqual(['sync', 'feed']);
    expect((await loadActiveManifest())?.id).toBe('m2');
    expect((await heldBlobs([A, B, C])).sort()).toEqual([A, B].sort());
  });

  it('refuses a feed image that is not a plain image type, or larger than the cap, while it arrives (#196)', async () => {
    const SVG = await sha('<svg/>');
    const HTML = await sha('<p>hi</p>');
    const JPEG = await sha('jpeg bytes');
    const big = new Uint8Array(2 * FEED_IMAGE_MAX_BYTES);
    const BIG = [...new Uint8Array(await crypto.subtle.digest('SHA-256', big))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const LONG = '1'.repeat(64);
    /** Chunks of `big` sent, so a test can tell the download stopped part way. */
    let sent = 0;
    const chunk = 1_000_000;
    const unsized = () =>
      new ReadableStream<Uint8Array>(
        {
          pull(c) {
            if (sent * chunk >= big.byteLength) return c.close();
            c.enqueue(big.subarray(sent * chunk, ++sent * chunk));
          },
        },
        { highWaterMark: 0 },
      );
    let longRead = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith(`/blobs/${SVG}`)) return new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } });
        if (url.endsWith(`/blobs/${HTML}`)) return new Response('<p>hi</p>', { headers: { 'content-type': 'text/html' } });
        if (url.endsWith(`/blobs/${JPEG}`)) return new Response('jpeg bytes', { headers: { 'content-type': 'Image/JPEG; q=1' } });
        // Its hash matches: only the cap refuses it.
        if (url.endsWith(`/blobs/${BIG}`)) return new Response(unsized(), { headers: { 'content-type': 'image/jpeg' } });
        if (url.endsWith(`/blobs/${LONG}`)) {
          const body = new ReadableStream<Uint8Array>({ pull: (c) => ((longRead = true), c.close()) }, { highWaterMark: 0 });
          return new Response(body, { headers: { 'content-type': 'image/jpeg', 'content-length': String(FEED_IMAGE_MAX_BYTES + 1) } });
        }
        return handle(input, init);
      }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await syncFeedImages(BASE, [SVG, HTML, JPEG, BIG, LONG], { headers: auth });
    expect(await heldBlobs([SVG, HTML, JPEG, BIG, LONG])).toEqual([JPEG]);
    expect((await open('sf-blobs-v1').match(`/_sf/blob/${JPEG}`))?.headers.get('content-type')).toBe('image/jpeg');
    // Stopped once past the cap, not read to the end and then hashed.
    expect(sent * chunk).toBeGreaterThan(FEED_IMAGE_MAX_BYTES);
    expect(sent).toBeLessThan(big.byteLength / chunk);
    // A length over the cap is refused before the body is read.
    expect(longRead).toBe(false);
    expect(warn.mock.calls.map((c) => String(c[1]))).toEqual([
      'Error: not an image a screen shows: image/svg+xml',
      'Error: not an image a screen shows: text/html',
      'Error: too large',
      'Error: too large',
    ]);
    expect((await open('sf-blobs-v1').keys()).every((k) => k.url.includes('/_sf/blob/'))).toBe(true);
    warn.mockRestore();
  });

  it('rethrows UnauthorisedError on 401 when fetching feed images', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'unauthorized' }, { status: 401 })),
    );
    await expect(syncFeedImages(BASE, ['a'.repeat(64)], { headers: auth })).rejects.toBeInstanceOf(UnauthorisedError);
  });
});

describe('DeviceCredential', () => {
  const noSupervisor = vi.fn(async () => Promise.reject(new TypeError('Failed to fetch')));
  const API = 'https://api.example/v1/device';

  it('collects the credential from the supervisor once and sends it as a bearer header', async () => {
    const f = vi.fn(async () => Response.json({ credential: 'sfd_scr_1.secret', api: API }));
    const c = new DeviceCredential(API, 'http://127.0.0.1:8091', noSupervisor, f);
    expect(await c.headers()).toEqual({ authorization: 'Bearer sfd_scr_1.secret' });
    expect(await c.headers()).toEqual({ authorization: 'Bearer sfd_scr_1.secret' });
    expect(f).toHaveBeenCalledTimes(1);
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe('http://127.0.0.1:8091/credential');
  });

  it('says none while the supervisor has none, and takes one installed later', async () => {
    const f = vi.fn(async () => Response.json({ error: 'no credential' }, { status: 404 }));
    const c = new DeviceCredential(API, 'http://127.0.0.1:8091', noSupervisor, f);
    expect(await c.check()).toBe('none');
    expect(await c.headers()).toEqual({});
    f.mockImplementation(async () => Response.json({ credential: 'sfd_scr_1.new', api: API }));
    expect(await c.check()).toBe('held');
    expect(await c.headers()).toEqual({ authorization: 'Bearer sfd_scr_1.new' });
  });

  it('on revoke, deletes it from the supervisor and never uses it again', async () => {
    const f = vi.fn(async () => Response.json({ credential: 'sfd_scr_1.old', api: API }));
    const send = vi.fn(async () => Response.json({}));
    const c = new DeviceCredential(API, 'http://127.0.0.1:8091', send, f);
    expect(await c.check()).toBe('held');
    await c.revoke();
    expect(send).toHaveBeenCalledWith('/credential', { method: 'DELETE' });
    // A supervisor that still hands it out (its delete failed) is not believed.
    expect(await c.check()).toBe('none');
    expect(c.held).toBe(false);
  });

  it('hands a paired credential to the supervisor, and uses it even when the supervisor cannot take it', async () => {
    const send = vi.fn(async (_path: string, _init: RequestInit) => Promise.reject(new TypeError('Failed to fetch')));
    const c = new DeviceCredential(API, 'http://127.0.0.1:8091', send, noSupervisor);
    await c.adopt('sfd_scr_2.paired');
    expect(send.mock.calls[0]![0]).toBe('/credential');
    expect(JSON.parse(String(send.mock.calls[0]![1].body))).toEqual({ credential: 'sfd_scr_2.paired', api: API });
    expect(await c.headers()).toEqual({ authorization: 'Bearer sfd_scr_2.paired' });
  });

  it('does not use a credential bound to another API base, or to none', async () => {
    for (const api of ['https://other.example/v1/device', 'https://api.example/v1/devices', null, undefined]) {
      const c = new DeviceCredential(
        API,
        'http://127.0.0.1:8091',
        noSupervisor,
        vi.fn(async () => Response.json({ credential: 'sfd_scr_1.secret', api })),
      );
      expect(await c.check(), String(api)).toBe('elsewhere');
      expect(await c.headers()).toEqual({});
      expect(c.held).toBe(false);
    }
  });

  it('treats an unreachable supervisor as unknown, sending nothing', async () => {
    const c = new DeviceCredential(API, 'http://127.0.0.1:8091', noSupervisor, noSupervisor);
    expect(await c.check()).toBe('unknown');
    expect(await c.headers()).toEqual({});
  });
});
