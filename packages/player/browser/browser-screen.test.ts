// A browser test screen (M3-41): the player in a tab on the CMS's hostname, with no supervisor.
// It pairs as `kind: browser`, keeps its credential in IndexedDB, sends no cookie with any device
// request (the API there sits beside the user's session), never asks a supervisor, and ignores
// display power commands. A revoke wipes its credential and cache. The credential goes only to
// the API base it paired with: the tab is on the CMS's origin, where anyone can open it with
// another `content=`.
import { expect, it } from 'vitest';
import type { FixtureServer } from './fixture-server';
import { useHarness, type Player } from './harness';

const h = useHarness();

/** The API on the player's own origin, as the CMS serves it, beside a session cookie. */
async function openTestScreen(content: ReturnType<typeof h.content>): Promise<Player> {
  const p = await h.openPlayer(
    (server) => {
      server.sameOriginApi = true;
      server.authorised.clear();
      server.publish(content);
    },
    (server: FixtureServer) => ({ content: `${server.url}/content`, kind: 'browser', pairmove: '1' }),
  );
  await p.page.context().addCookies([{ name: 'sf.session_token', value: 'a-user-session', url: p.server.url }]);
  await p.page.reload();
  return p;
}

const storedCredential = (p: Player) =>
  p.page.evaluate(
    () =>
      new Promise<unknown>((resolve, reject) => {
        const open = indexedDB.open('sf-device');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('credential')) return resolve(undefined);
          const get = db.transaction('credential').objectStore('credential').get('credential');
          get.onsuccess = () => resolve(get.result);
          get.onerror = () => reject(get.error);
        };
      }),
  );

const blobsHeld = (p: Player) => p.page.evaluate(async () => (await (await caches.open('sf-blobs-v1')).keys()).length);

it('pairs as a browser, keeps its credential across a reload, and sends no cookie and nothing to a supervisor', async () => {
  const content = h.content([{ id: 'a', durationMs: 800 }]);
  const p = await openTestScreen(content);
  // A supervisor that holds a credential is there to be ignored: a test screen has none.
  const s = await p.until((s) => s.pairing !== '');
  expect(new Set(p.server.pairings.map((x) => x.kind))).toEqual(new Set(['browser']));

  const credential = p.server.claim(s.pairing);
  await p.until((s) => s.manifestId === content.manifest.id && s.played > 0 && s.socket, 15_000);
  expect(await storedCredential(p)).toEqual({ credential, api: `${p.server.url}/content` });

  const codes = p.server.pairings.length;
  await p.page.reload();
  await p.until((s) => s.played > 0 && s.socket, 15_000);
  expect(p.server.pairings).toHaveLength(codes);
  expect(p.server.requestsTo(/^\/supervisor\//)).toEqual([]);
  expect(p.server.requestsTo(/^\/content\//).filter((r) => r.status === 401)).toEqual([]);
});

it('ignores display power commands', async () => {
  const content = h.content([{ id: 'a', durationMs: 800 }]);
  const p = await openTestScreen(content);
  p.server.claim((await p.until((s) => s.pairing !== '')).pairing);
  await p.until((s) => s.played > 0 && s.socket, 15_000);
  p.server.push({ type: 'command', command: { type: 'display', override: { state: 'off', until: new Date(Date.now() + 3_600_000).toISOString() } } });
  await expect.poll(() => p.console.some((l) => l.includes('command display'))).toBe(true);
  const before = (await p.state()).played;
  await p.until((s) => s.played > before + 1);
  expect((await p.state()).displayOn).toBe(true);
});

it('revoked: wipes its credential and cache, and shows a code again, after a reload too', async () => {
  const content = h.content([{ id: 'a', durationMs: 800 }]);
  const p = await openTestScreen(content);
  const credential = p.server.claim((await p.until((s) => s.pairing !== '')).pairing);
  await p.until((s) => s.played > 0 && s.socket, 15_000);
  expect(await blobsHeld(p)).toBeGreaterThan(0);

  p.server.revoke(credential);
  const s = await p.until((s) => s.pairing !== '', 15_000);
  expect(s.manifestId).toBe('');
  expect(await blobsHeld(p)).toBe(0);
  expect(await storedCredential(p)).toBeUndefined();

  await p.page.reload();
  await p.until((s) => s.pairing !== '' && s.manifestId === '');
});

it('opened with another API, sends that API nothing, does not pair, and keeps its credential', async () => {
  const content = h.content([{ id: 'a', durationMs: 800 }]);
  const p = await openTestScreen(content);
  const credential = p.server.claim((await p.until((s) => s.pairing !== '')).pairing);
  await p.until((s) => s.played > 0 && s.socket, 15_000);

  const foreign = await h.playerServer();
  await p.page.goto(`${p.server.url}/?${new URLSearchParams({ poll: '1', kind: 'browser', pairmove: '1', content: foreign.deviceApi })}`);
  const s = await p.until((s) => s.auth === 'paired with another API');
  await new Promise((r) => setTimeout(r, 2000));
  expect(foreign.requests).toEqual([]);
  expect((await p.state()).pairing).toBe('');
  expect(s.pairing).toBe('');
  expect(await storedCredential(p)).toEqual({ credential, api: `${p.server.url}/content` });
});
