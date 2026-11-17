// The guard: on `/api`, only Better Auth and the tool route change data, and the tool route
// changes it only through the dispatcher, which writes the audit log. The test enumerates the
// Worker's routes, so a new route fails here until it is either read-only or listed below.
import { scoped } from '@signforge/db';
import { registry } from '@signforge/tools';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../src/index';
import { Client, email, testApp } from './client';

/**
 * Every route that is not a GET, and why it may change data. `/api` allows exactly Better Auth
 * and the tool route. Other trees list each route with its reason; a screen reporting about
 * itself on `/v1/device` (M3-07's sync) goes here too, as a deliberate decision.
 */
const WRITERS: Record<string, string> = {
  'POST /api/auth/*': 'Better Auth: sign-in, organizations, members, invitations',
  'POST /api/tools/:name': 'the tool registry, through the dispatcher',
  'POST /admin/screens/:screen/missing': 'reads only: POST because the body is a manifest',
  'PUT /admin/screens/:screen/blobs/:sha256': 'sf push: content-addressed bytes in R2, inert until a publish names them',
  'PUT /admin/base/blobs/:sha256': 'sf push: content-addressed bytes in R2, inert until a publish names them',
  'PUT /admin/screens/:screen/manifest': 'sf push: stores the manifest file, then publishes through the dispatcher (admin.test.ts checks the audit row)',
};
/** Middleware each tree mounts on its whole prefix. A wildcard on any other path is a route and fails. */
const MIDDLEWARE = new Set(['ALL /api/*', 'ALL /v1/device/*', 'ALL /admin/*']);
/** Better Auth's own GETs may write its tables (OAuth callbacks, sign-out links). */
const AUTH_GET = 'GET /api/auth/*';

/** Better Auth's tables. Writes to any other table are ours and must come from the dispatcher. */
const AUTH_TABLES = new Set(['user', 'session', 'account', 'verification', 'organization', 'member', 'invitation', 'rateLimit']);
const WRITE = /^\s*(?:insert\s+(?:or\s+\w+\s+)?into|replace\s+into|update(?:\s+or\s+\w+)?|delete\s+from)\s+["`]?(\w+)/i;

/** A D1 binding that records the table of every write statement prepared through it. */
function recordingD1(db: D1Database, writes: string[]): D1Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          const m = WRITE.exec(sql);
          if (m) writes.push(m[1]!);
          return target.prepare(sql);
        };
      }
      if (prop === 'exec') throw new Error('exec is not expected on a request path');
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

const routes = () => [...new Set(app.routes.map((r) => `${r.method} ${r.path}`))];

describe('the route table', () => {
  it('has no route that changes data except those listed', () => {
    const unexpected = routes().filter((r) => !r.startsWith('GET ') && !MIDDLEWARE.has(r) && !(r in WRITERS));
    expect(unexpected, 'a new route that is not a GET: make it a tool, or list it in WRITERS with a reason').toEqual([]);
  });

  it('allows exactly Better Auth and the tool route to change data on /api', () => {
    expect(Object.keys(WRITERS).filter((r) => r.split(' ')[1]!.startsWith('/api/'))).toEqual(['POST /api/auth/*', 'POST /api/tools/:name']);
    // Every listed writer still exists, so the list cannot rot.
    for (const r of Object.keys(WRITERS)) expect(routes(), r).toContain(r);
  });
});

describe('requests', () => {
  const t = testApp();
  const writes: string[] = [];
  let owner: Client;
  let screenId: string;

  beforeAll(async () => {
    const setup = new Client(t);
    await setup.signIn(email('guard'));
    const org = await setup.createOrg('Guard');
    screenId = (await scoped(env.DB, org.id).screens.insert({ name: 'Guarded', timezone: 'UTC', orientation: 'landscape' })).id;
    // The same session, on a D1 binding that records writes.
    owner = new Client(t, setup.ip, { ...env, DB: recordingD1(env.DB, writes) });
    for (const [k, v] of setup.jar) owner.jar.set(k, v);
  });

  const ours = () => writes.filter((table) => !AUTH_TABLES.has(table));

  it('to every GET on /api, other than Better Auth, write nothing of ours', async () => {
    const gets = routes().filter((r) => r.startsWith('GET /api/') && r !== AUTH_GET);
    expect(gets.length).toBeGreaterThan(0);
    for (const r of gets) {
      writes.length = 0;
      const path = r.slice('GET '.length).replace(/:\w+/g, 'x');
      const res = await owner.get(path);
      expect(res.status, r).toBe(200);
      expect(ours(), r).toEqual([]);
    }
  });

  it('to a read tool write nothing, and to a changing tool write the audit log with the change', async () => {
    for (const tool of registry.values()) {
      if (tool.mutates) continue;
      writes.length = 0;
      const example = tool.example as Record<string, unknown>;
      const input = 'screenId' in example ? { ...example, screenId } : example;
      expect((await owner.tool(tool.name, input)).status, tool.name).toBe(200);
      expect(ours(), tool.name).toEqual([]);
    }

    writes.length = 0;
    expect((await owner.tool('rename_screen', { screenId, name: 'Renamed' })).status).toBe(200);
    expect(ours()).toEqual(['screens', 'audit_log']);

    // A change that finds nothing (its UPDATE matched no row) is not audited.
    writes.length = 0;
    expect((await owner.tool('rename_screen', { screenId: 'scr_nobody', name: 'x' })).status).toBe(404);
    expect(ours()).not.toContain('audit_log');
  });
});

describe('POST /api/tools/:name', () => {
  const t = testApp();
  const owner = new Client(t);
  const viewer = new Client(t);
  let screenId: string;

  beforeAll(async () => {
    await owner.signIn(email('owner'));
    await viewer.signIn(email('viewer'));
    const org = await owner.createOrg('Tools');
    screenId = (await scoped(env.DB, org.id).screens.insert({ name: 'Lobby', timezone: 'UTC', orientation: 'landscape' })).id;
    const invite = await owner.ok<{ id: string }>('/api/auth/organization/invite-member', { email: (await viewer.session()).body.user.email, role: 'viewer', organizationId: org.id });
    await viewer.ok('/api/auth/organization/accept-invitation', { invitationId: invite.id });
    expect((await viewer.setActive(org.id)).status).toBe(200);
  });

  it('maps refusals to HTTP statuses', async () => {
    const cases: [Client, string, unknown, number, string][] = [
      [owner, 'no_such_tool', {}, 404, 'unknown_tool'],
      [owner, 'rename_screen', { screenId, name: '' }, 400, 'invalid_input'],
      [owner, 'rename_screen', { screenId: 'scr_nobody', name: 'x' }, 404, 'not_found'],
      [viewer, 'rename_screen', { screenId, name: 'x' }, 403, 'forbidden'],
    ];
    for (const [who, name, input, status, error] of cases) {
      const res = await who.tool(name, input);
      expect(res.status, name).toBe(status);
      expect(await res.json(), name).toMatchObject({ error, message: expect.any(String) });
    }
  });

  it('records the session user as the actor, through the cms client', async () => {
    const res = await owner.tool('rename_screen', { screenId, name: 'Front desk' });
    expect(await res.json()).toMatchObject({ screen: { id: screenId, name: 'Front desk' } });
    const { user, organization } = (await owner.session()).body;
    const [entry] = await scoped(env.DB, organization.id).auditLog.list({ limit: 1 });
    expect(entry).toMatchObject({ actorKind: 'user', actorId: user.id, clientId: 'cms', action: 'rename_screen', targetKind: 'screen', targetId: screenId });
  });

  it('takes JSON only', async () => {
    const form = await owner.request('POST', '/api/tools/rename_screen', undefined, { 'content-type': 'text/plain' });
    expect(form.status).toBe(415);
    const broken = await owner.request('POST', '/api/tools/list_screens', undefined, { 'content-type': 'application/json' });
    expect(broken.status).toBe(200); // an empty body is an empty input
  });

  it('lists what the caller may use', async () => {
    const names = async (c: Client) => ((await (await c.get('/api/tools')).json()) as { tools: { name: string }[] }).tools.map((x) => x.name);
    expect(await names(owner)).toHaveLength(registry.size);
    expect((await names(viewer)).sort()).toEqual(['get_screen', 'list_groups', 'list_screens']);
  });
});
