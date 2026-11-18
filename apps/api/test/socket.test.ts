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
import { HOLDER_HEADER, type SocketHolder } from '../src/device/screen-object';
import { screenNotifier, screenObject } from '../src/device/screens';
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
const upgrade = (ticket: string, headers: Record<string, string> = {}) =>
  exports.default.fetch(`${BASE}/ws?ticket=${encodeURIComponent(ticket)}`, { headers: { upgrade: 'websocket', ...headers } });

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

/** Wait until the screen's row reports `manifest`. */
async function reportedIs(s: Screen, manifest: string) {
  const reported = async () => (await s.seed.scope.screens.get(s.seed.screen))?.reportedManifestId;
  const end = Date.now() + 3000;
  while ((await reported()) !== manifest && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  expect(await reported()).toBe(manifest);
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

  it('lets a session cookie through on the upgrade, and decides by the ticket alone', async () => {
    // A test screen on the CMS's hostname cannot keep its user's cookie off a WebSocket handshake.
    const cookie = { cookie: 'sf.session_token=x' };
    expect((await upgrade('', cookie)).status).toBe(401);
    expect(await (await upgrade('', cookie)).json()).toEqual({ error: 'unauthorized' });
    const ticket = ((await (await sync(a.credential)).json()) as SyncResponse).socketTicket;
    const res = await upgrade(ticket, cookie);
    expect(res.status).toBe(101);
    res.webSocket?.accept();
    res.webSocket?.close(1000);
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

  it('carries identify, restart and a display override from the CMS to the screen at once', async () => {
    const s = await connect(((await (await sync(a.credential)).json()) as SyncResponse).socketTicket);
    for (const [tool, input] of [
      ['identify_screen', {}],
      ['restart_screen', {}],
      ['set_display_override', { state: 'off' }],
    ] as const) {
      const r = await dispatch(registry, tool, { screenId: a.seed.screen, ...input }, caller(a, 'editor'));
      expect(r.ok, tool).toBe(true);
    }
    await until(() => s.messages.filter((m) => typeof m === 'object').length >= 3);
    const commands = s.messages.flatMap((m) => (typeof m === 'object' && m.type === 'command' ? [m.command] : []));
    expect(commands).toEqual([
      { type: 'identify', name: expect.any(String), seconds: 10 },
      { type: 'restart' },
      { type: 'display', override: { state: 'off', until: expect.any(String) } },
    ]);
    s.ws.close(1000);
  });

  it('writes what the screen applied through to D1', async () => {
    const s = await connect(((await (await sync(a.credential)).json()) as SyncResponse).socketTicket);
    s.ws.send(JSON.stringify({ type: 'applied', manifest: M2 }));
    await reportedIs(a, M2);
    // Nothing of org B's changed.
    expect((await scoped(env.DB, b.seed.orgId).screens.get(b.seed.screen))?.reportedManifestId).toBeNull();
    s.ws.close(1000);
  });

  it("leaves the screen's version alone, so an editor opened before the rollout still saves", async () => {
    const s = await connect(((await (await sync(a.credential)).json()) as SyncResponse).socketTicket);
    const before = (await a.seed.scope.screens.get(a.seed.screen))!;
    s.ws.send(JSON.stringify({ type: 'applied', manifest: M1 }));
    await reportedIs(a, M1);
    await sync(a.credential, { ...syncBody(), manifest: { active: M1, filesMissing: 0 } });
    expect(await a.seed.scope.screens.get(a.seed.screen)).toMatchObject({ rowVersion: before.rowVersion, updatedAt: before.updatedAt });
    const r = await dispatch(registry, 'rename_screen', { screenId: a.seed.screen, name: 'Lobby', ifVersion: before.rowVersion }, caller(a, 'editor'));
    expect(r.ok).toBe(true);
    s.ws.close(1000);
  });

  it('shows the manifest the screen reported last, over either transport', async () => {
    const s = await connect(((await (await sync(a.credential)).json()) as SyncResponse).socketTicket);
    await dispatch(registry, 'publish_manifest_to_screen', { screenId: a.seed.screen, manifestId: M2 }, caller(a));
    s.ws.send(JSON.stringify({ type: 'applied', manifest: M1 }));
    await reportedIs(a, M1);
    // The socket drops; the screen adopts M2 over HTTP and says so in its heartbeat.
    s.ws.close(1000);
    await sync(a.credential, { ...syncBody(), manifest: { active: M2, filesMissing: 0 } });
    await reportedIs(a, M2);
    const r = await dispatch(registry, 'get_screen', { screenId: a.seed.screen }, caller(a));
    expect(r.ok && (r.output as { screen: { state: { kind: string } } }).screen.state.kind).toBe('online');
    // It falls back to M1 and the reopened socket says so: this object last wrote M1 too, and still writes it.
    const again = await connect(((await (await sync(a.credential)).json()) as SyncResponse).socketTicket);
    again.ws.send(JSON.stringify({ type: 'applied', manifest: M1 }));
    await reportedIs(a, M1);
    again.ws.close(1000);
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

describe('revoking a credential whose socket is open', () => {
  const ticketFor = async (credential: string) => ((await (await sync(credential)).json()) as SyncResponse).socketTicket;
  const revoke = (s: Screen, as: Caller = caller(s)) =>
    dispatch(registry, 'revoke_screen_credential', { screenId: s.seed.screen, credentialId: s.credentialId }, as);
  /** The real notifier, except that the revocation's own notice never reaches the object. */
  const unreachable = (s: Screen): Caller => ({
    ...caller(s),
    screens: { ...screenNotifier(env), revoked: () => Promise.reject(new Error('object unreachable')) },
  });
  const settle = () => new Promise((r) => setTimeout(r, 100));

  it('closes the socket instead of sending it the next command when the first close never arrived', async () => {
    const c = await setUp('ws-c');
    const s = await connect(await ticketFor(c.credential));
    expect((await revoke(c, unreachable(c))).ok).toBe(true);
    await settle();
    expect(s.closed()).toBeUndefined();

    expect((await dispatch(registry, 'identify_screen', { screenId: c.seed.screen }, caller(c, 'editor'))).ok).toBe(true);
    await until(() => s.closed() !== undefined);
    expect(s.messages).toEqual([{ type: 'revoked' }]);
  });

  it('closes it when the revoke is retried', async () => {
    const c = await setUp('ws-d');
    const s = await connect(await ticketFor(c.credential));
    await revoke(c, unreachable(c));
    await settle();
    expect(s.closed()).toBeUndefined();

    expect((await revoke(c)).ok).toBe(true);
    await until(() => s.closed() !== undefined);
    expect(s.messages).toContainEqual({ type: 'revoked' });
  });

  it('does not write what such a socket says it applied', async () => {
    const c = await setUp('ws-e');
    const s = await connect(await ticketFor(c.credential));
    await revoke(c, unreachable(c));
    s.ws.send(JSON.stringify({ type: 'applied', manifest: M1 }));
    await until(() => s.closed() !== undefined);
    expect((await scoped(env.DB, c.seed.orgId).screens.get(c.seed.screen))?.reportedManifestId).toBeNull();
  });

  it('refuses an upgrade that reaches the object after the revocation did', async () => {
    const c = await setUp('ws-f');
    // The route found the credential live, then the revocation committed and told the object
    // before the route handed the upgrade over.
    const holder: SocketHolder = { orgId: c.seed.orgId, screenId: c.seed.screen, credentialId: c.credentialId };
    await ticketFor(c.credential);
    expect((await revoke(c)).ok).toBe(true);
    const res = await screenObject(env, c.seed.screen).fetch(
      new Request(`${BASE}/ws`, { headers: { upgrade: 'websocket', [HOLDER_HEADER]: JSON.stringify(holder) } }),
    );
    expect(res.status).toBe(401);
    expect(res.webSocket).toBeNull();
  });
});
