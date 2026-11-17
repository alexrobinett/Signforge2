// A session for org A cannot read or change org B's data, even with org B's ids.
import { env, exports } from 'cloudflare:workers';
import { scoped } from '@signforge/db';
import { beforeAll, describe, expect, it } from 'vitest';
import { Client, email, testApp, type Api } from './client';

/** Routes a CMS handler would have: they only ever see `c.var.org`. */
function probeRoutes(api: Api) {
  api.get('/probe/screens', async (c) => c.json({ orgId: c.var.orgId, role: c.var.role, screens: await c.var.org.screens.list() }));
  api.get('/probe/screens/:id', async (c) => {
    const row = await c.var.org.screens.get(c.req.param('id'));
    return row ? c.json(row) : c.json({ error: 'not_found' }, 404);
  });
  api.patch('/probe/screens/:id', async (c) => {
    const { name } = await c.req.json<{ name: string }>();
    const row = await c.var.org.screens.update(c.req.param('id'), { name });
    return row ? c.json(row) : c.json({ error: 'not_found' }, 404);
  });
}

const t = testApp({ extend: probeRoutes });
const alice = new Client(t);
const bob = new Client(t);
let orgA: string;
let orgB: string;
let screenA: string;
let screenB: string;

beforeAll(async () => {
  await alice.signIn(email('alice'));
  await bob.signIn(email('bob'));
  orgA = (await alice.createOrg('Org A')).id;
  orgB = (await bob.createOrg('Org B')).id;
  screenA = (await scoped(env.DB, orgA).screens.insert({ name: 'A lobby', timezone: 'UTC', orientation: 'landscape' })).id;
  screenB = (await scoped(env.DB, orgB).screens.insert({ name: 'B lobby', timezone: 'UTC', orientation: 'landscape' })).id;
});

describe('a session for org A', () => {
  it('sees its own org through the scope', async () => {
    const res = await alice.get('/api/probe/screens');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orgId: string; role: string; screens: { id: string }[] };
    expect(body).toMatchObject({ orgId: orgA, role: 'owner' });
    expect(body.screens.map((s) => s.id)).toEqual([screenA]);
    expect((await alice.get(`/api/probe/screens/${screenA}`)).status).toBe(200);
  });

  it("cannot read or change org B's screen by id", async () => {
    expect((await alice.get(`/api/probe/screens/${screenB}`)).status).toBe(404);
    expect((await alice.patch(`/api/probe/screens/${screenB}`, { name: 'hijacked' })).status).toBe(404);
    expect(await scoped(env.DB, orgB).screens.get(screenB)).toMatchObject({ name: 'B lobby' });
  });

  it('cannot pick org B from the request', async () => {
    // The org comes from the session alone; nothing in the request selects it.
    const res = await alice.get(`/api/probe/screens?organizationId=${orgB}&orgId=${orgB}`, { 'x-organization-id': orgB });
    expect(((await res.json()) as { orgId: string }).orgId).toBe(orgA);
  });

  it('cannot make org B active', async () => {
    expect((await alice.setActive(orgB)).status).toBe(403);
    expect((await alice.get(`/api/probe/screens/${screenB}`)).status).toBe(404);
  });

  it('loses org B as soon as it is removed, though its cache cookie still names org B', async () => {
    // Bob invites Alice into org B; she accepts and switches to it.
    const invite = await bob.ok<{ id: string }>('/api/auth/organization/invite-member', { email: (await alice.session()).body.user.email, role: 'viewer', organizationId: orgB });
    await alice.ok('/api/auth/organization/accept-invitation', { invitationId: invite.id });
    expect((await alice.setActive(orgB)).status).toBe(200);
    expect((await alice.get(`/api/probe/screens/${screenB}`)).status).toBe(200);

    // Bob removes her. Her session cache cookie (valid for minutes) still says org B is active.
    const cookieBefore = alice.cookie;
    await bob.ok('/api/auth/organization/remove-member', { memberIdOrEmail: (await alice.session()).body.user.email, organizationId: orgB });
    expect(alice.cookie).toBe(cookieBefore);
    const res = await alice.get(`/api/probe/screens/${screenB}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_a_member' });
  });
});

describe('credentials stay on their own tree', () => {
  it('/api refuses a device credential, even alongside a valid session', async () => {
    const res = await bob.get('/api/probe/screens', { authorization: 'Bearer crd_secret' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'device_credential_not_accepted' });
    expect((await bob.get('/api/session', { authorization: 'Bearer crd_secret' })).status).toBe(401);
  });

  it('/api refuses a request with no session', async () => {
    const anon = new Client(t);
    expect((await anon.get('/api/probe/screens')).status).toBe(401);
    expect((await anon.get('/api/session')).status).toBe(401);
  });

  it('/v1/device refuses a session cookie', async () => {
    const res = await exports.default.fetch('https://api.test/v1/device/manifest', { headers: { cookie: bob.cookie, authorization: 'Bearer crd_secret' } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'session_not_accepted' });
    // Any of our cookies, under either name form.
    for (const cookie of ['sf.session_token=x', '__Secure-sf.session_data=y', 'other=1; sf.dont_remember=1']) {
      expect((await exports.default.fetch('https://api.test/v1/device/x', { headers: { cookie } })).status, cookie).toBe(401);
    }
    // Unrelated cookies are not a session: the request passes the session guard and is refused
    // by the device tree itself, for having no credential.
    const unrelated = await exports.default.fetch('https://api.test/v1/device/x', { headers: { cookie: 'theme=dark' } });
    expect(unrelated.status).toBe(401);
    expect(await unrelated.json()).toEqual({ error: 'unauthorized' });
  });
});
