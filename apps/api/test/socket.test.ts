// The nudge socket (M3-06): sync issues a ticket, `/v1/device/ws` trades it for a hibernating
// WebSocket on the screen's Durable Object, publishing and revoking reach that socket, and the
// screen's `applied` is written through to D1.
import type { ServerSocketMessage, SyncRequest, SyncResponse } from '@signforge/contract';
import { scoped } from '@signforge/db';
import { seedOrg, type SeededOrg } from '@signforge/db/testing';
import { dispatch, registry, type Caller } from '@signforge/tools';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintCredential } from '../src/device/credential';
import { screenNotifier } from '../src/device/screens';
import { issueTicket, verifyTicket } from '../src/device/ticket';
import { manifestKey } from '../src/r2';

const BASE = 'https://api.test/v1/device';
const M1 = '1'.repeat(64);
const M2 = '2'.repeat(64);

interface Screen {
  seed: SeededOrg;
  credential: string;
  credentialId: string;
}

async function setUp(orgId: string): Promise<Screen> {
  const seed = await seedOrg(env.DB, orgId);
  const { credential, secretHash } = await mintCredential(seed.screen);
  const row = await seed.scope.screens.credentials.insert({ screenId: seed.screen, secretHash });
  for (const id of [M1, M2]) await env.BLOBS.put(manifestKey(orgId, seed.screen, id), '{}');
  return { seed, credential, credentialId: row.id };
}

const syncBody = (): SyncRequest => ({
  seq: 0,
  epoch: 'e1',
  player: { version: 'test', manifestSchemas: [2, 3], protocols: [1, 2] },
  manifest: { filesMissing: 0 },
  display: { on: true },
  deviceTime: new Date().toISOString(),
  clock: { offsetMs: 0, trusted: false },
  playCounts: [],
  snapshots: {},
});

async function sync(credential: string, body: unknown = syncBody()) {
  return exports.default.fetch(`${BASE}/sync`, {
    method: 'POST',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** The response to a socket upgrade with this ticket. */
const upgrade = (ticket: string) => exports.default.fetch(`${BASE}/ws?ticket=${encodeURIComponent(ticket)}`, { headers: { upgrade: 'websocket' } });

/** An open socket and the messages it has received. */
async function connect(ticket: string) {
  const res = await upgrade(ticket);
  const ws = res.webSocket;
  if (!ws) throw new Error(`socket refused with ${res.status}`);
  ws.accept();
  const messages: (ServerSocketMessage | string)[] = [];
  let closed: number | undefined;
  ws.addEventListener('message', (e) => {
    const text = String(e.data);
    try {
      messages.push(JSON.parse(text) as ServerSocketMessage);
    } catch {
      messages.push(text);
    }
  });
  ws.addEventListener('close', (e) => void (closed = e.code));
  return { status: res.status, ws, messages, closed: () => closed };
}

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const caller = (s: Screen, role: Caller['role'] = 'owner'): Caller => ({
  org: scoped(env.DB, s.seed.orgId),
  role,
  actor: { kind: 'user', id: 'socket-test' },
  blobs: env.BLOBS,
  screens: screenNotifier(env),
});

let a: Screen;
let b: Screen;
beforeAll(async () => {
  a = await setUp('ws-a');
  b = await setUp('ws-b');
});

describe('socket tickets', () => {
  it('verify for the screen and credential they were issued to, for 60 seconds', async () => {
    const now = Date.parse('2026-11-17T12:00:00Z');
    const ticket = await issueTicket(env, { screenId: 'scr_x', credentialId: 'crd_y' }, now);
    expect(ticket).not.toContain('sfd_');
    expect(await verifyTicket(env, ticket, now + 59_000)).toEqual({ screenId: 'scr_x', credentialId: 'crd_y' });
    expect(await verifyTicket(env, ticket, now + 61_000)).toBeUndefined();
    const [screen, ...rest] = ticket.split('.');
    expect(await verifyTicket(env, ['scr_z', ...rest].join('.'), now)).toBeUndefined();
    expect(screen).toBe('scr_x');
    expect(await verifyTicket(env, `${ticket.slice(0, -2)}AA`, now)).toBeUndefined();
    expect(await verifyTicket(env, 'garbage', now)).toBeUndefined();
  });
});

describe('POST /v1/device/sync', () => {
  it('answers a screen with nothing published with a socket ticket and the server time', async () => {
    const res = await sync(a.credential);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SyncResponse;
    expect(body.socketTicket.startsWith(`${a.seed.screen}.`)).toBe(true);
    expect(body.desiredManifest).toBeUndefined();
    expect(body.epoch).toBe('e1');
    expect(Math.abs(Date.parse(body.serverTime) - Date.now())).toBeLessThan(5000);
  });

  it('refuses a request that is not a sync request, and a screen without a credential', async () => {
    expect((await sync(a.credential, { seq: 'x' })).status).toBe(400);
    expect((await sync('sfd_ws-a-screen.nope')).status).toBe(401);
  });
});

describe('GET /v1/device/ws', () => {
  it('refuses a missing or forged ticket', async () => {
    expect((await upgrade('')).status).toBe(401);
    expect((await upgrade('ws-a-screen.crd.1.AAAA')).status).toBe(401);
  });

  it('answers keepalive pings without the object, and carries a publish to the screen at once', async () => {
    const ticket = ((await (await sync(a.credential)).json()) as SyncResponse).socketTicket;
    const s = await connect(ticket);
    expect(s.status).toBe(101);
    s.ws.send('ping');
    await until(() => s.messages.includes('pong'));

    const r = await dispatch(registry, 'publish_manifest_to_screen', { screenId: a.seed.screen, manifestId: M1 }, caller(a, 'editor'));
    expect(r.ok).toBe(true);
    await until(() => s.messages.some((m) => typeof m === 'object' && m.type === 'manifest'));
    expect(s.messages.filter((m) => typeof m === 'object')).toEqual([{ type: 'manifest', id: M1 }]);

    // The next sync names it too.
    expect(((await (await sync(a.credential)).json()) as SyncResponse).desiredManifest).toBe(M1);
    s.ws.close(1000);
  });

  it('writes what the screen applied through to D1', async () => {
    const s = await connect(((await (await sync(a.credential)).json()) as SyncResponse).socketTicket);
    s.ws.send(JSON.stringify({ type: 'applied', manifest: M2 }));
    const reported = async () => (await scoped(env.DB, a.seed.orgId).screens.get(a.seed.screen))?.reportedManifestId;
    const end = Date.now() + 3000;
    while ((await reported()) !== M2 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(await reported()).toBe(M2);
    // Nothing of org B's changed.
    expect((await scoped(env.DB, b.seed.orgId).screens.get(b.seed.screen))?.reportedManifestId).toBeNull();
    s.ws.close(1000);
  });

  it("does not reach another screen's socket", async () => {
    const sa = await connect(((await (await sync(a.credential)).json()) as SyncResponse).socketTicket);
    const sb = await connect(((await (await sync(b.credential)).json()) as SyncResponse).socketTicket);
    await dispatch(registry, 'publish_manifest_to_screen', { screenId: b.seed.screen, manifestId: M2 }, caller(b));
    await until(() => sb.messages.length > 0);
    await new Promise((r) => setTimeout(r, 100));
    expect(sa.messages).toEqual([]);
    sa.ws.close(1000);
    sb.ws.close(1000);
  });

  it('closes the socket when its credential is revoked, and refuses the ticket after', async () => {
    const ticket = ((await (await sync(b.credential)).json()) as SyncResponse).socketTicket;
    const s = await connect(ticket);
    const r = await dispatch(registry, 'revoke_screen_credential', { screenId: b.seed.screen, credentialId: b.credentialId }, caller(b));
    expect(r.ok).toBe(true);
    await until(() => s.closed() !== undefined);
    expect(s.messages).toContainEqual({ type: 'revoked' });
    expect((await upgrade(ticket)).status).toBe(401);
  });
});
