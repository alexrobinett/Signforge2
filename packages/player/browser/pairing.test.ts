// Pairing (M3-08): a screen with no credential shows a code and polls; once the code is claimed it
// stores its credential with the supervisor and plays, with no restart. A revoked screen wipes what
// it holds and shows a code again (owner decision Q2, the default).
import { expect, it } from 'vitest';
import { FIXTURE_CREDENTIAL, type FixtureServer } from './fixture-server';
import { useHarness, type Player } from './harness';

const h = useHarness();

/** Content on another origin, as the API is. `pairmove` moves the code every second instead of every minute. */
const remote = (server: FixtureServer) => ({ content: `${server.localUrl}/content`, poll: '1', pairmove: '1' });

/** The code element's text and where it is, or undefined while it is hidden. */
const shown = (p: Player) =>
  p.page.evaluate(() => {
    const el = document.getElementById('pair');
    if (!el || getComputedStyle(el).display === 'none') return undefined;
    const box = el.querySelector('.code')!.getBoundingClientRect();
    return { text: el.textContent ?? '', x: Math.round(box.x), y: Math.round(box.y) };
  });

const blobsHeld = (p: Player) => p.page.evaluate(async () => (await (await caches.open('sf-blobs-v1')).keys()).length);

it('a freshly flashed screen shows a code, and plays once it is claimed, without a restart', async () => {
  const content = h.content([{ id: 'a', durationMs: 800, label: 'first' }]);
  const p = await h.openPlayer((server) => {
    server.supervisorCredential = undefined;
    server.authorised.clear();
    server.publish(content);
  }, remote);
  const s = await p.until((s) => s.pairing !== '');
  expect(s.manifestId).toBe('');
  const first = (await shown(p))!;
  expect(first.text.replace(/\s/g, '')).toContain(s.pairing);

  // OLED: the code does not sit still.
  await expect
    .poll(
      async () => {
        const now = await shown(p);
        return now && (now.x !== first.x || now.y !== first.y);
      },
      { timeout: 5000 },
    )
    .toBe(true);

  const credential = p.server.claim(s.pairing);
  await p.until((s) => s.manifestId === content.manifest.id && s.played > 0, 15_000);
  expect(await shown(p)).toBeUndefined();
  expect(p.server.supervisorCredential).toBe(credential);
  expect(p.server.supervisorApi).toBe(p.server.deviceApi);
  expect(p.server.requestsTo(/^\/$/)).toHaveLength(1); // no reload
});

it('asks for a new code when one expires unclaimed', async () => {
  const p = await h.openPlayer((server) => {
    server.supervisorCredential = undefined;
    server.pairingTtlMs = 1500;
  }, remote);
  const first = (await p.until((s) => s.pairing !== '')).pairing;
  const second = (await p.until((s) => s.pairing !== '' && s.pairing !== first, 10_000)).pairing;
  expect(p.server.pairings.map((x) => x.code)).toContain(second);
});

it('revoked: wipes what it holds and shows a code, then pairs again', async () => {
  const content = h.content([{ id: 'a', durationMs: 800 }]);
  const p = await h.openPlayer((server) => server.publish(content), remote);
  await p.until((s) => s.played > 0 && s.socket);
  expect(await blobsHeld(p)).toBeGreaterThan(0);

  p.server.revoke(FIXTURE_CREDENTIAL);
  const s = await p.until((s) => s.pairing !== '', 15_000);
  expect(s.manifestId).toBe('');
  expect(s.lastGood).toBe('');
  expect(await blobsHeld(p)).toBe(0);
  expect(p.server.supervisorCredential).toBeUndefined();
  expect(await p.page.evaluate(() => document.querySelectorAll('.slot iframe, .slot img, .slot video').length)).toBe(0);

  p.server.claim(s.pairing);
  await p.until((s) => s.manifestId === content.manifest.id && s.played > 0, 15_000);
});

it('revoked while a first download retries: the transfer stops, and nothing of it is stored or played', async () => {
  // A 2 MB file of the spot's own, sent slowly enough to be in flight when the revoke comes.
  const content = h.content([{ id: 'a', durationMs: 800, asset: Buffer.alloc(2_000_000, 7) }]);
  let fail = () => {};
  const p = await h.openPlayer((server) => {
    server.publish(content);
    fail = server.intercept(/^\/content\/blobs\//, { status: 404 });
  }, remote);
  const blobs = () => p.server.requestsTo(/^\/content\/blobs\//).filter((r) => r.bearer);
  await expect.poll(() => blobs().some((r) => r.status === 404), { timeout: 10_000 }).toBe(true);
  fail();
  p.server.intercept(/^\/content\/blobs\//, { bytesPerSecond: 200_000 });
  const asset = content.manifest.spots.a!.kind === 'template' ? content.manifest.spots.a!.assets.file! : '';
  await expect.poll(() => blobs().some((r) => r.path.endsWith(asset) && r.status === 200), { timeout: 10_000 }).toBe(true);
  await p.until((s) => s.socket);

  // Nothing played, nothing counted: the screen wipes and pairs where it is, without a reload.
  p.server.revoke(FIXTURE_CREDENTIAL);
  await p.until((s) => s.pairing !== '', 15_000);
  const transfer = blobs().find((r) => r.path.endsWith(asset) && r.status === 200)!;
  await expect.poll(() => transfer.abortedAt, { timeout: 5000 }).toBeDefined();
  // Longer than the rest of the transfer would have taken.
  await new Promise((r) => setTimeout(r, 11_000));
  const s = await p.state();
  expect(s.manifestId).toBe('');
  expect(s.pairing).not.toBe('');
  expect(await blobsHeld(p)).toBe(0);
  expect(await p.page.evaluate(async () => !!(await (await caches.open('sf-state-v1')).match('/_sf/manifest/active')))).toBe(false);
  expect(p.server.requestsTo(/^\/$/)).toHaveLength(1);
});

it('a 401 on sync with a credential is a revoke too', async () => {
  const content = h.content([{ id: 'a', durationMs: 800 }]);
  const p = await h.openPlayer((server) => server.publish(content), remote);
  await p.until((s) => s.played > 0 && s.socket);
  // Revoked while the socket was down, so no `revoked` reached it: the next sync is refused.
  p.server.intercept(/^\/content\/ws$/, { status: 503 });
  p.server.authorised.clear();
  p.server.dropSockets();
  await p.until((s) => s.pairing !== '', 15_000);
  expect(await blobsHeld(p)).toBe(0);
});

it('takes a credential installed by hand while it shows a code', async () => {
  const content = h.content([{ id: 'a', durationMs: 800 }]);
  const p = await h.openPlayer((server) => {
    server.supervisorCredential = undefined;
    server.publish(content);
  }, remote);
  await p.until((s) => s.pairing !== '');
  p.server.supervisorCredential = FIXTURE_CREDENTIAL;
  p.server.supervisorApi = p.server.deviceApi;
  await p.until((s) => s.pairing === '' && s.played > 0, 15_000);
});

// The credential goes only to the device API it was paired with, never to whatever API the
// player's address names: a paired screen opened with another `content=` must not hand it over.
it('a paired screen whose address names another API sends that API nothing, and keeps its credential', async () => {
  const foreign = await h.playerServer();
  const p = await h.openPlayer(undefined, { content: foreign.deviceApi, poll: '1', pairmove: '1' });
  const s = await p.until((s) => s.auth === 'paired with another API');
  await new Promise((r) => setTimeout(r, 2000));
  expect(foreign.requests).toEqual([]);
  expect(s.pairing).toBe('');
  expect(p.server.supervisorCredential).toBe(FIXTURE_CREDENTIAL);
  expect(p.server.supervisorApi).toBe(p.server.deviceApi);
});

it('nor does one whose address names another path on the same origin', async () => {
  const p = await h.openPlayer(undefined, (server) => ({ content: `${server.localUrl}/elsewhere`, poll: '1' }));
  await p.until((s) => s.auth === 'paired with another API');
  await new Promise((r) => setTimeout(r, 1500));
  expect(p.server.requests.filter((r) => r.bearer)).toEqual([]);
});

it('does not send a credential the supervisor holds for no API (one stored before credentials were bound)', async () => {
  const content = h.content([{ id: 'a', durationMs: 800 }]);
  const p = await h.openPlayer((server) => {
    server.publish(content);
    server.supervisorApi = undefined;
  }, remote);
  await p.until((s) => s.auth === 'paired with another API');
  await new Promise((r) => setTimeout(r, 1500));
  expect(p.server.requests.filter((r) => r.bearer)).toEqual([]);
  expect(p.server.supervisorCredential).toBe(FIXTURE_CREDENTIAL);
});

it('sends its credential only to its own API', async () => {
  const content = h.content([{ id: 'a', durationMs: 800 }]);
  const p = await h.openPlayer((server) => server.publish(content), remote);
  await p.until((s) => s.played > 0 && s.socket);
  const sent = p.server.requests.filter((r) => r.bearer);
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.every((r) => r.path.startsWith('/content/') && r.bearer === FIXTURE_CREDENTIAL)).toBe(true);
});
