// The nudge socket (M3-06): sync issues a ticket, `/v1/device/ws` trades it for a hibernating
// WebSocket on the screen's Durable Object, publishing and revoking reach that socket, and the
// screen's `applied` is written through to D1.
import { MANIFEST_SCHEMA, type ScreenManifest, type ServerSocketMessage, type SyncRequest, type SyncResponse } from '@signforge/contract';
import { scoped } from '@signforge/db';
import { seedOrg, type SeededOrg } from '@signforge/db/testing';
import { dispatch, registry, type Caller } from '@signforge/tools';
import { runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { mintCredential } from '../src/device/credential';
import { HOLDER_HEADER, ScreenObject, type SocketHolder } from '../src/device/screen-object';
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
  for (const id of [M1, M2]) {
    const manifest: ScreenManifest = {
      schema: MANIFEST_SCHEMA,
      id,
      generatedAt: '2026-11-17T00:00:00.000Z',
      screen: { id: seed.screen, name: 'Lobby', timezone: 'UTC', orientation: 'landscape' },
      files: {},
      templates: {},
      spots: {},
      playlists: {},
      dataSources: {},
      schedule: [],
      defaultPlaylist: 'p',
    };
    await env.BLOBS.put(manifestKey(orgId, seed.screen, id), JSON.stringify(manifest));
  }
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

/** An open socket, the messages it has received, and when it closed. */
async function connect(ticket: string) {
  const res = await upgrade(ticket);
  const ws = res.webSocket;
  if (!ws) throw new Error(`socket refused with ${res.status}`);
  ws.accept();
  const messages: (ServerSocketMessage | string)[] = [];
  const arrived: (() => void)[] = [];
  ws.addEventListener('message', (e) => {
    const text = String(e.data);
    try {
      messages.push(JSON.parse(text) as ServerSocketMessage);
    } catch {
      messages.push(text);
    }
    for (const wake of arrived.splice(0)) wake();
  });
  const closed = new Promise<number>((r) => ws.addEventListener('close', (e) => r(e.code)));
  /** The messages, once there are `n` of them. */
  const received = async (n: number) => {
    while (messages.length < n) await new Promise<void>((r) => arrived.push(r));
    return messages;
  };
  return { status: res.status, ws, messages, received, closed };
}

/**
 * Every message a screen object took from a socket, and its handling. The runtime starts a message's
 * handler while an earlier one still awaits D1, and answers a ping without the object, so neither a
 * later message nor a pong says that a message was handled: only the handler's return does.
 */
const taken: { message: string | ArrayBuffer; done: Promise<void> }[] = [];
const takenWake: (() => void)[] = [];
beforeAll(() => {
  const handle = ScreenObject.prototype.webSocketMessage;
  vi.spyOn(ScreenObject.prototype, 'webSocketMessage').mockImplementation(function (this: ScreenObject, ws, message) {
    const done = handle.call(this, ws, message);
    taken.push({ message, done });
    for (const wake of takenWake.splice(0)) wake();
    return done;
  });
});

/**
 * Send `text` on the screen's socket and wait until its object has handled it. The wait runs in the
 * object: a promise of the object's settles only there, and a test resumed by it could not use its own socket.
 */
async function say(s: Screen, ws: WebSocket, text: string) {
  const from = taken.length;
  ws.send(text);
  await runInDurableObject(screenObject(env, s.seed.screen), async () => {
    for (;;) {
      const call = taken.slice(from).find((t) => t.message === text);
      if (call) return call.done;
      await new Promise<void>((r) => takenWake.push(r));
    }
  });
}

const reported = async (s: Screen) => (await s.seed.scope.screens.get(s.seed.screen))?.reportedManifestId;

const caller = (s: Screen, role: Caller['role'] = 'owner'): Caller => ({
  org: scoped(env.DB, s.seed.orgId),
  role,
  actor: { kind: 'user', id: 'socket-test' },
  blobs: env.BLOBS,
  services: { notify: screenNotifier(env) },
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
    onTestFinished(() => void vi.useRealTimers());
    vi.setSystemTime('2026-11-20T12:00:00Z');
    const res = await sync(a.credential);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SyncResponse;
    expect(body.socketTicket.startsWith(`${a.seed.screen}.`)).toBe(true);
    expect(body.desiredManifest).toBeUndefined();
    expect(body.epoch).toBe('e1');
    expect(body.serverTime).toBe('2026-11-20T12:00:00.000Z');
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
    expect(await s.received(1)).toEqual(['pong']);

    const r = await dispatch(registry, 'publish_manifest_to_screen', { screenId: a.seed.screen, manifestId: M1 }, caller(a, 'editor'));
    expect(r.ok).toBe(true);
    expect(await s.received(2)).toEqual(['pong', { type: 'manifest', id: M1 }]);

    // The next sync names it too.
    expect(((await (await sync(a.credential)).json()) as SyncResponse).desiredManifest).toBe(M1);
    s.ws.close(1000);
  });

  it('carries identify, restart and a display override from the CMS to the screen at once', async () => {
    const s = await connect(((await (await sync(a.credential)).json()) as SyncResponse).socketTicket);
    for (const command of ['identify', 'restart', 'display_off'] as const) {
      const r = await dispatch(registry, 'screen_command', { screenId: a.seed.screen, command }, caller(a, 'editor'));
      expect(r.ok, command).toBe(true);
    }
    const commands = (await s.received(3)).flatMap((m) => (typeof m === 'object' && m.type === 'command' ? [m.command] : []));
    expect(commands).toEqual([
      { type: 'identify', name: expect.any(String), seconds: 10 },
      { type: 'restart' },
      { type: 'display', override: { state: 'off', until: expect.any(String) } },
    ]);
    s.ws.close(1000);
  });

  it('writes what the screen applied through to D1', async () => {
    const s = await connect(((await (await sync(a.credential)).json()) as SyncResponse).socketTicket);
    await say(a, s.ws, JSON.stringify({ type: 'applied', manifest: M2 }));
    expect(await reported(a)).toBe(M2);
    // Nothing of org B's changed.
    expect((await scoped(env.DB, b.seed.orgId).screens.get(b.seed.screen))?.reportedManifestId).toBeNull();
    s.ws.close(1000);
  });

  it("leaves the screen's version alone, so an editor opened before the rollout still saves", async () => {
    const s = await connect(((await (await sync(a.credential)).json()) as SyncResponse).socketTicket);
    const before = (await a.seed.scope.screens.get(a.seed.screen))!;
    await say(a, s.ws, JSON.stringify({ type: 'applied', manifest: M1 }));
    expect(await reported(a)).toBe(M1);
    await sync(a.credential, { ...syncBody(), manifest: { active: M1, filesMissing: 0 } });
    expect(await a.seed.scope.screens.get(a.seed.screen)).toMatchObject({ rowVersion: before.rowVersion, updatedAt: before.updatedAt });
    const r = await dispatch(registry, 'update_screen', { screenId: a.seed.screen, name: 'Lobby', ifVersion: before.rowVersion }, caller(a, 'editor'));
    expect(r.ok).toBe(true);
    s.ws.close(1000);
  });

  it('shows the manifest the screen reported last, over either transport', async () => {
    const s = await connect(((await (await sync(a.credential)).json()) as SyncResponse).socketTicket);
    await dispatch(registry, 'publish_manifest_to_screen', { screenId: a.seed.screen, manifestId: M2 }, caller(a));
    await say(a, s.ws, JSON.stringify({ type: 'applied', manifest: M1 }));
    expect(await reported(a)).toBe(M1);
    // The socket drops; the screen adopts M2 over HTTP and says so in its heartbeat.
    s.ws.close(1000);
    await sync(a.credential, { ...syncBody(), manifest: { active: M2, filesMissing: 0 } });
    expect(await reported(a)).toBe(M2);
    const r = await dispatch(registry, 'get_screen', { screenId: a.seed.screen }, caller(a));
    expect(r.ok && (r.output as { screen: { state: { kind: string } } }).screen.state.kind).toBe('online');
    // It falls back to M1 and the reopened socket says so: this object last wrote M1 too, and still writes it.
    const again = await connect(((await (await sync(a.credential)).json()) as SyncResponse).socketTicket);
    await say(a, again.ws, JSON.stringify({ type: 'applied', manifest: M1 }));
    expect(await reported(a)).toBe(M1);
    again.ws.close(1000);
  });

  it("does not reach another screen's socket", async () => {
    const sa = await connect(((await (await sync(a.credential)).json()) as SyncResponse).socketTicket);
    const sb = await connect(((await (await sync(b.credential)).json()) as SyncResponse).socketTicket);
    await dispatch(registry, 'publish_manifest_to_screen', { screenId: b.seed.screen, manifestId: M2 }, caller(b));
    expect(await sb.received(1)).toEqual([{ type: 'manifest', id: M2 }]);
    // A dispatch returns once the object has sent, so whatever the publish sent A's socket comes before this.
    await dispatch(registry, 'screen_command', { screenId: a.seed.screen, command: 'identify' }, caller(a, 'editor'));
    expect(await sa.received(1)).toEqual([{ type: 'command', command: { type: 'identify', name: expect.any(String), seconds: 10 } }]);
    sa.ws.close(1000);
    sb.ws.close(1000);
  });

  it('closes the socket when its credential is revoked, and refuses the ticket after', async () => {
    const ticket = ((await (await sync(b.credential)).json()) as SyncResponse).socketTicket;
    const s = await connect(ticket);
    const r = await dispatch(registry, 'revoke_screen_credential', { screenId: b.seed.screen, credentialId: b.credentialId }, caller(b));
    expect(r.ok).toBe(true);
    await s.closed;
    expect(s.messages).toEqual([{ type: 'revoked' }]);
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
    services: { notify: { ...screenNotifier(env), revoked: () => Promise.reject(new Error('object unreachable')) } },
  });
  /** The socket is open: the object sent it nothing before its answer to a ping, which comes after anything sent so far. */
  const stillOpen = async (s: Awaited<ReturnType<typeof connect>>) => {
    s.ws.send('ping');
    expect(await s.received(1)).toEqual(['pong']);
  };

  it('closes the socket instead of sending it the next command when the first close never arrived', async () => {
    const c = await setUp('ws-c');
    const s = await connect(await ticketFor(c.credential));
    expect((await revoke(c, unreachable(c))).ok).toBe(true);
    await stillOpen(s);

    expect((await dispatch(registry, 'screen_command', { screenId: c.seed.screen, command: 'identify' }, caller(c, 'editor'))).ok).toBe(true);
    await s.closed;
    expect(s.messages).toEqual(['pong', { type: 'revoked' }]);
  });

  it('closes it when the revoke is retried', async () => {
    const c = await setUp('ws-d');
    const s = await connect(await ticketFor(c.credential));
    await revoke(c, unreachable(c));
    await stillOpen(s);

    expect((await revoke(c)).ok).toBe(true);
    await s.closed;
    expect(s.messages).toEqual(['pong', { type: 'revoked' }]);
  });

  it('does not write what such a socket says it applied', async () => {
    const c = await setUp('ws-e');
    const s = await connect(await ticketFor(c.credential));
    await revoke(c, unreachable(c));
    await say(c, s.ws, JSON.stringify({ type: 'applied', manifest: M1 }));
    expect(await reported(c)).toBeNull();
    await s.closed;
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

describe('the order of reports (gh-44)', () => {
  // Each report arrives at NOW on the server's clock (vi.setSystemTime: the object runs in the tests' isolate),
  // unless a test moves it; t0 is well before, so every observation here is before it arrives.
  const NOW = Date.parse('2026-11-20T12:00:00Z');
  const t0 = NOW - 600_000;
  beforeEach(() => vi.setSystemTime(NOW));
  afterEach(() => vi.useRealTimers());
  const iso = (ms: number) => new Date(ms).toISOString();
  const ticketFor = async (s: Screen) => ((await (await sync(s.credential)).json()) as SyncResponse).socketTicket;
  /** A sync reporting `active`, observed at `at` on a trusted clock that runs 5 s behind the server's. */
  const syncObserved = (s: Screen, active: string, at: number) =>
    sync(s.credential, { ...syncBody(), manifest: { active, filesMissing: 0 }, deviceTime: iso(at - 5000), clock: { offsetMs: 5000, trusted: true } });
  /** Report `manifest` over the socket, and wait until the object has written or skipped it. */
  const applied = (c: Screen, ws: WebSocket, manifest: string, observedAt?: number) =>
    say(c, ws, JSON.stringify({ type: 'applied', manifest, ...(observedAt === undefined ? {} : { observedAt: iso(observedAt) }) }));

  it('keeps what the socket reported over a sync observed before it that arrives after', async () => {
    const c = await setUp('ws-g');
    await dispatch(registry, 'publish_manifest_to_screen', { screenId: c.seed.screen, manifestId: M2 }, caller(c));
    const s = await connect(await ticketFor(c));
    await applied(c, s.ws, M2, t0 + 20_000);
    expect(await reported(c)).toBe(M2);
    // The sync was built on M1 at t0 + 10 s and was still in flight.
    expect((await syncObserved(c, M1, t0 + 10_000)).status).toBe(200);
    expect(await reported(c)).toBe(M2);
    const r = await dispatch(registry, 'get_screen', { screenId: c.seed.screen }, caller(c));
    expect(r.ok && (r.output as { screen: { state: { kind: string } } }).screen.state.kind).toBe('online');
    s.ws.close(1000);
  });

  it('takes the newer observation over either transport, keeps the first of two at one time, and leaves the version alone', async () => {
    const c = await setUp('ws-h');
    const before = (await c.seed.scope.screens.get(c.seed.screen))!;
    const s = await connect(await ticketFor(c));
    await applied(c, s.ws, M2, t0 + 20_000);
    expect(await reported(c)).toBe(M2);
    await syncObserved(c, M1, t0 + 30_000);
    expect(await reported(c)).toBe(M1);
    await applied(c, s.ws, M2, t0 + 40_000);
    expect(await reported(c)).toBe(M2);
    await applied(c, s.ws, M1, t0 + 35_000);
    expect(await reported(c)).toBe(M2);
    await syncObserved(c, M1, t0 + 40_000);
    expect(await reported(c)).toBe(M2);
    await applied(c, s.ws, M1, t0 + 40_000);
    expect(await reported(c)).toBe(M2);
    expect(await c.seed.scope.screens.get(c.seed.screen)).toMatchObject({ rowVersion: before.rowVersion, updatedAt: before.updatedAt });
    s.ws.close(1000);
  });

  it('moves the time on a newer repeat over the socket, so a sync observed before it cannot win', async () => {
    const c = await setUp('ws-k');
    const s = await connect(await ticketFor(c));
    await applied(c, s.ws, M2, t0 + 20_000);
    expect(await reported(c)).toBe(M2);
    // The screen went M2, M1 (never reported on the socket), M2 again: the resend is newer.
    await applied(c, s.ws, M2, t0 + 60_000);
    // A sync built on M1 at t0 + 40 s lands after the resend.
    await syncObserved(c, M1, t0 + 40_000);
    expect(await reported(c)).toBe(M2);
    s.ws.close(1000);
  });

  it('orders a report without a time, or from an untrusted clock, by when it arrived', async () => {
    const c = await setUp('ws-i');
    const s = await connect(await ticketFor(c));
    await applied(c, s.ws, M2, t0 + 20_000);
    expect(await reported(c)).toBe(M2);
    // A player from before gh-44.
    await applied(c, s.ws, M1);
    expect(await reported(c)).toBe(M1);
    // An untrusted clock, whatever time it says.
    await sync(c.credential, { ...syncBody(), manifest: { active: M2, filesMissing: 0 }, deviceTime: iso(t0), clock: { offsetMs: 0, trusted: false } });
    expect(await reported(c)).toBe(M2);
    // A report by arrival is a time a later observation is ordered against: this one was before it.
    await syncObserved(c, M1, t0 + 30_000);
    expect(await reported(c)).toBe(M2);
    s.ws.close(1000);
  });

  it('counts an observation later than its arrival as its arrival, so a clock ahead cannot hold the column', async () => {
    const c = await setUp('ws-j');
    const s = await connect(await ticketFor(c));
    await applied(c, s.ws, M2, NOW + 3_600_000);
    expect(await reported(c)).toBe(M2);
    // A second later, a sync observed then: newer than the report's arrival, though not its stated time.
    vi.setSystemTime(NOW + 1000);
    await syncObserved(c, M1, NOW + 1000);
    expect(await reported(c)).toBe(M1);
    s.ws.close(1000);
  });

  it("takes a socket's messages one at a time, so reports without a time land in the order sent (gh-177)", async () => {
    const c = await setUp('ws-l');
    const s = await connect(await ticketFor(c));
    // What the object did, in order: each message's read of the screen's live credentials, and each message's return.
    const log: string[] = [];
    // The first message's read is held until the object has taken the second message. Held at the D1
    // binding, which the object shares with the tests' isolate.
    const held = Promise.withResolvers<void>();
    let holdNext = true;
    const d1 = Object.getPrototypeOf(env.DB) as D1Database;
    const prepare = d1.prepare;
    const prepared = vi.spyOn(d1, 'prepare').mockImplementation(function (this: D1Database, query) {
      if (query.includes('"screen_credentials"')) log.push('read');
      return prepare.call(this, query);
    });
    // Drizzle prepares, binds and runs a select in one go, so the first statement run is the first read.
    const statement = Object.getPrototypeOf(prepare.call(env.DB, 'select 1')) as D1PreparedStatement;
    const raw = statement.raw;
    const ran = vi.spyOn(statement, 'raw').mockImplementation(async function (this: D1PreparedStatement, ...args) {
      if (holdNext) {
        holdNext = false;
        await held.promise;
      }
      return raw.apply(this, args);
    });
    onTestFinished(() => {
      prepared.mockRestore();
      ran.mockRestore();
    });
    const from = taken.length;
    s.ws.send(JSON.stringify({ type: 'applied', manifest: M1 }));
    s.ws.send(JSON.stringify({ type: 'applied', manifest: M2 }));
    await runInDurableObject(screenObject(env, c.seed.screen), async () => {
      while (taken.length < from + 2) await new Promise<void>((r) => takenWake.push(r));
      const calls = taken.slice(from);
      const done = calls.map((t) => t.done.then(() => void log.push('done')));
      held.resolve();
      await Promise.all(done);
    });
    expect(log).toEqual(['read', 'done', 'read', 'done']);
    expect(await reported(c)).toBe(M2);
    s.ws.close(1000);
  });
});
