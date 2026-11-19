// Publishing from the CMS (M3-18): the publish tool through the API's caller, its org lock, and
// the queue that tells the screens it switched.
import type { ServerSocketMessage, SyncRequest, SyncResponse } from '@signforge/contract';
import { scoped } from '@signforge/db';
import { seedOrg } from '@signforge/db/testing';
import { dispatch, registry, type Caller } from '@signforge/tools';
import { runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { mintCredential } from '../src/device/credential';
import { queueNotices, screenNotifier, type PublishNotice } from '../src/device/screens';
import { deliverNotices, publishLock, type OrgObject } from '../src/publish';

const BASE = 'https://api.test/v1/device';

async function until(check: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const syncBody: SyncRequest = {
  seq: 0,
  epoch: 'e1',
  player: { version: 'test', manifestSchemas: [2, 3], protocols: [1, 2] },
  manifest: { filesMissing: 0 },
  display: { on: true },
  deviceTime: new Date().toISOString(),
  clock: { offsetMs: 0, trusted: false },
  playCounts: [],
  snapshots: {},
};

describe('publish through the API', () => {
  it("switches a screen and reaches its open socket through the queue, holding the org's lock", async () => {
    const seed = await seedOrg(env.DB, 'api-publish');
    const org = scoped(env.DB, seed.orgId);
    const { credential, secretHash } = await mintCredential(seed.screen);
    await org.screens.credentials.insert({ screenId: seed.screen, secretHash });
    const sync = async () =>
      (await (
        await exports.default.fetch(`${BASE}/sync`, {
          method: 'POST',
          headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
          body: JSON.stringify(syncBody),
        })
      ).json()) as SyncResponse;
    const res = await exports.default.fetch(`${BASE}/ws?ticket=${encodeURIComponent((await sync()).socketTicket)}`, { headers: { upgrade: 'websocket' } });
    const ws = res.webSocket!;
    ws.accept();
    const messages: ServerSocketMessage[] = [];
    ws.addEventListener('message', (e) => void messages.push(JSON.parse(String(e.data)) as ServerSocketMessage));

    let locked = 0;
    const lock = publishLock(env, seed.orgId);
    const caller: Caller = {
      org,
      role: 'editor',
      actor: { kind: 'user', id: 'user-1', clientId: 'cms' },
      blobs: env.BLOBS,
      screens: screenNotifier(env),
      publishLock: (run) => ((locked += 1), lock(run)),
    };
    expect(await dispatch(registry, 'set_default_playlist', { playlistId: seed.playlist }, caller)).toMatchObject({ ok: true });
    const r = await dispatch(registry, 'publish', {}, caller);
    expect(r).toMatchObject({ ok: true, output: { publish: { revision: 1, screens: 1 } } });
    expect(locked).toBe(1);
    const desired = (await org.screens.get(seed.screen))!.desiredManifestId!;
    await until(() => messages.some((m) => m.type === 'manifest'));
    expect(messages).toEqual([{ type: 'manifest', id: desired }]);
    // The screen can fetch what it was told of.
    const manifest = await exports.default.fetch(`${BASE}/manifest.json`, { headers: { authorization: `Bearer ${credential}` } });
    expect(manifest.status).toBe(200);
    expect(((await manifest.json()) as { id: string }).id).toBe(desired);
    ws.close(1000);
  });
});

describe('the queue', () => {
  it('carries 50 screens a message', async () => {
    const sent: MessageSendRequest<PublishNotice>[][] = [];
    const screens = Array.from({ length: 120 }, (_, i) => ({ screenId: `scr_${i}`, manifestId: 'a'.repeat(64) }));
    await queueNotices(
      { PUBLISH_NOTICES: { sendBatch: async (m: MessageSendRequest<PublishNotice>[]) => void sent.push(m) } as unknown as Queue<PublishNotice> },
      screens,
    );
    expect(sent.map((batch) => batch.map((m) => m.body.screens.length))).toEqual([[50, 50, 20]]);
    expect(sent[0]!.flatMap((m) => m.body.screens)).toEqual(screens);
  });

  it('tells every screen of a message and retries a message one of whose screens it could not reach', async () => {
    const told: string[] = [];
    const SCREENS = {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        manifest: async (id: string) => {
          if (name === 'scr_down') throw new Error('object unreachable');
          told.push(`${name}:${id}`);
        },
      }),
    } as unknown as Env['SCREENS'];
    const outcome: string[] = [];
    const message = (id: string, screens: string[]) => ({
      id,
      body: { screens: screens.map((screenId) => ({ screenId, manifestId: 'm' })) },
      ack: () => void outcome.push(`${id} ack`),
      retry: () => void outcome.push(`${id} retry`),
    });
    const batch = { messages: [message('one', ['scr_a', 'scr_b']), message('two', ['scr_c', 'scr_down'])] } as unknown as MessageBatch<PublishNotice>;
    await deliverNotices(batch, { SCREENS });
    expect(told.sort()).toEqual(['scr_a:m', 'scr_b:m', 'scr_c:m']);
    expect(outcome.sort()).toEqual(['one ack', 'two retry']);
  });
});

describe("the org's publish lock", () => {
  it('lets one publish hold it at a time, and is taken over once a lease has run out', async () => {
    const org = env.ORGS.get(env.ORGS.idFromName('lock-org'));
    const first = await org.acquire();
    let second: string | undefined;
    const waiting = org.acquire().then((t) => (second = t));
    await new Promise((r) => setTimeout(r, 50));
    expect(second).toBeUndefined();
    await org.release(first);
    await waiting;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);

    // A holder that died: its lease runs out, and the next call takes the lock.
    await runInDurableObject(org, async (_o: OrgObject, state) => {
      await state.storage.put('publish', { token: second, until: Date.now() - 1 });
    });
    const third = await org.acquire();
    expect(third).not.toBe(second);
    // A late release from the dead holder releases nothing.
    await org.release(second!);
    let fourth: string | undefined;
    void org.acquire().then((t) => (fourth = t));
    await new Promise((r) => setTimeout(r, 50));
    expect(fourth).toBeUndefined();
    await org.release(third);
    await until(() => fourth !== undefined);
  });
});
