import { env } from 'cloudflare:workers';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { TAB_ORG_HEADER } from '../src/api/tab-org';
import { Client, email, testApp } from './client';

describe('sign-up and sign-in by email code', () => {
  it('creates the user on first sign-in, and signs the same user in again', async () => {
    const t = testApp();
    const addr = email('new');
    const first = new Client(t);
    const signedUp = await first.signIn(addr);
    expect(signedUp.user.email).toBe(addr);
    expect(signedUp.user.id).toMatch(/^usr_[a-z2-7]{24}$/);
    expect(t.outbox.last(addr)?.subject).toMatch(/^Your SignForge code: \d{6}$/);

    const second = new Client(t);
    const again = await second.signIn(addr);
    expect(again.user.id).toBe(signedUp.user.id);
    const s = await second.session();
    expect(s).toEqual({ status: 200, body: { user: { id: signedUp.user.id, email: addr, name: expect.any(String) }, organization: null } });
  });

  it('refuses a wrong code and stores codes hashed', async () => {
    const t = testApp();
    const addr = email('wrong');
    const c = new Client(t);
    await c.ok('/api/auth/email-otp/send-verification-otp', { email: addr, type: 'sign-in' });
    const code = c.codeFor(addr);
    const wrong = code === '000000' ? '111111' : '000000';
    const res = await c.post('/api/auth/sign-in/email-otp', { email: addr, otp: wrong });
    expect(res.status).toBe(400);
    expect((await c.session()).status).toBe(401);
    const rows = await env.DB.prepare('SELECT value FROM verification WHERE identifier LIKE ?').bind(`%${addr}%`).all<{ value: string }>();
    expect(rows.results.length).toBeGreaterThan(0);
    for (const r of rows.results) expect(r.value).not.toContain(code);
  });

  it('signs out', async () => {
    const c = new Client(testApp());
    await c.signIn(email('out'));
    await c.ok('/api/auth/sign-out');
    expect((await c.session()).status).toBe(401);
  });
});

describe('organizations', () => {
  it('create, invite, accept and switch', async () => {
    const t = testApp();
    const owner = new Client(t);
    const ownerEmail = email('owner');
    await owner.signIn(ownerEmail);

    // Create: the creator is the owner, and the new org becomes active.
    const org = await owner.createOrg('Acme');
    expect(org.id).toMatch(/^org_/);
    expect((await owner.session()).body.organization).toEqual({ id: org.id, role: 'owner' });

    // Invite: the email carries the invitation id.
    const editorEmail = email('editor');
    const invite = await owner.ok<{ id: string; role: string }>('/api/auth/organization/invite-member', { email: editorEmail, role: 'editor' });
    const mail = t.outbox.last(editorEmail)!;
    expect(mail.subject).toBe('Join Acme on SignForge');
    expect(mail.text).toContain(`/accept-invitation/${invite.id}`);

    // Accept: the invitee signs in and joins as an editor.
    const editor = new Client(t);
    await editor.signIn(editorEmail);
    const accepted = await editor.ok<{ member: { role: string } }>('/api/auth/organization/accept-invitation', { invitationId: invite.id });
    expect(accepted.member.role).toBe('editor');
    expect((await editor.session()).body.organization).toEqual({ id: org.id, role: 'editor' });

    // An editor cannot invite; a stranger cannot accept someone else's invitation.
    expect((await editor.post('/api/auth/organization/invite-member', { email: email('x'), role: 'viewer' })).status).toBe(403);
    const viewerInvite = await owner.ok<{ id: string }>('/api/auth/organization/invite-member', { email: email('viewer'), role: 'viewer' });
    const stranger = new Client(t);
    await stranger.signIn(email('stranger'));
    expect((await stranger.post('/api/auth/organization/accept-invitation', { invitationId: viewerInvite.id })).status).toBe(403);

    // Switch: the editor makes their own org, then switches back to Acme.
    const own = await editor.createOrg('Editor Co');
    expect((await editor.session()).body.organization).toEqual({ id: own.id, role: 'owner' });
    expect((await editor.setActive(org.id)).status).toBe(200);
    expect((await editor.session()).body.organization).toEqual({ id: org.id, role: 'editor' });
  });

  it('allows only owner, editor and viewer', async () => {
    const owner = new Client(testApp());
    await owner.signIn(email('owner'));
    await owner.createOrg('Roles');
    for (const role of ['admin', 'member', 'editor,viewer', 'root']) {
      expect((await owner.post('/api/auth/organization/invite-member', { email: email('x'), role })).status, role).toBe(400);
    }
    expect((await owner.post('/api/auth/organization/invite-member', { email: email('x'), role: 'viewer' })).status).toBe(200);
  });

  it('cannot be deleted while deletion is off', async () => {
    const owner = new Client(testApp());
    await owner.signIn(email('owner'));
    const org = await owner.createOrg('Keep');
    const res = await owner.post('/api/auth/organization/delete', { organizationId: org.id });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await env.DB.prepare('SELECT id FROM organization WHERE id = ?').bind(org.id).first()).not.toBeNull();
  });

  it('leaves nothing usable when creation fails partway (no transactions on D1)', async () => {
    const t = testApp();
    const c = new Client(t);
    const { user } = await c.signIn(email('partial'));
    // Make the second step, adding the owner member, fail.
    await env.DB.exec(`CREATE TRIGGER fail_owner BEFORE INSERT ON member WHEN NEW.userId = '${user.id}' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    try {
      const res = await c.post('/api/auth/organization/create', { name: 'Half', slug: `half-${user.id}` });
      expect(res.status).toBeGreaterThanOrEqual(400);
    } finally {
      await env.DB.exec('DROP TRIGGER fail_owner');
    }
    // The org row may be left behind, but it has no member, so no one can use it.
    const orphan = await env.DB.prepare('SELECT id FROM organization WHERE slug = ?').bind(`half-${user.id}`).first<{ id: string }>();
    if (orphan) {
      expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM member WHERE organizationId = ?').bind(orphan.id).first('n')).toBe(0);
      expect((await c.setActive(orphan.id)).status).toBe(403);
    }
    expect((await c.session()).body.organization).toBeNull();
    expect((await c.get('/api/anything')).status).toBe(403);
  });
});

describe('the org a new session starts in (#182)', () => {
  /** A member of `orgs` new orgs, none of them made active by creating it. */
  async function memberOf(t: ReturnType<typeof testApp>, addr: string, names: string[]) {
    const c = new Client(t);
    await c.signIn(addr);
    const ids: string[] = [];
    for (const name of names) {
      const slug = `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`;
      ids.push((await c.ok<{ id: string }>('/api/auth/organization/create', { name, slug, keepCurrentActiveOrganization: true })).id);
    }
    expect((await c.session()).body.organization).toBeNull();
    return { c, ids };
  }

  /**
   * A second owner of `orgId`, so the member's own membership can end: an org always keeps an owner
   * (#292). Returns the statement that ends it, as leaving does.
   */
  async function secondOwner(t: ReturnType<typeof testApp>, orgId: string) {
    const { user } = await new Client(t).signIn(email('next-owner'));
    await env.DB.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', ?)")
      .bind(`mem-${user.id}`, orgId, user.id, new Date().toISOString())
      .run();
    return env.DB.prepare('DELETE FROM member WHERE organizationId = ? AND userId <> ?').bind(orgId, user.id);
  }

  it("is a member's only org, from the cookie the sign-in sets", async () => {
    const t = testApp();
    const addr = email('one-org');
    const { ids } = await memberOf(t, addr, ['Solo']);
    const fresh = new Client(t);
    await fresh.signIn(addr);
    expect((await fresh.session()).body.organization).toEqual({ id: ids[0], role: 'owner' });
  });

  it("is the org the tab check sees from a new session's first call", async () => {
    const t = testApp();
    const addr = email('first-call');
    const { ids } = await memberOf(t, addr, ['Solo']);
    // Each its own new session, so the call is the first after sign-in.
    const matching = new Client(t);
    await matching.signIn(addr);
    expect((await matching.tool('list_screens', {}, { [TAB_ORG_HEADER]: ids[0]! })).status).toBe(200);
    const stale = new Client(t);
    await stale.signIn(addr);
    expect((await stale.tool('list_screens', {}, { [TAB_ORG_HEADER]: 'org_elsewhere' })).status).toBe(409);
  });

  it('is the org last made active, in any session, after signing out', async () => {
    const t = testApp();
    const addr = email('two-orgs');
    const { c, ids } = await memberOf(t, addr, ['North', 'South']);
    expect((await c.setActive(ids[1]!)).status).toBe(200);
    await c.ok('/api/auth/sign-out');

    const fresh = new Client(t);
    await fresh.signIn(addr);
    expect((await fresh.session()).body.organization).toEqual({ id: ids[1], role: 'owner' });
    expect((await fresh.setActive(ids[0]!)).status).toBe(200);
    const later = new Client(t);
    await later.signIn(addr);
    expect((await later.session()).body.organization).toEqual({ id: ids[0], role: 'owner' });
  });

  it('is none for a member of several orgs who never chose one, so the CMS asks', async () => {
    const t = testApp();
    const addr = email('unchosen');
    await memberOf(t, addr, ['East', 'West']);
    const fresh = new Client(t);
    await fresh.signIn(addr);
    expect((await fresh.session()).body.organization).toBeNull();
  });

  it('is none when the org last made active is one the member has since left', async () => {
    const t = testApp();
    const addr = email('left');
    const { c, ids } = await memberOf(t, addr, ['Stay', 'Also', 'Gone']);
    expect((await c.setActive(ids[2]!)).status).toBe(200);
    await (await secondOwner(t, ids[2]!)).run();

    const fresh = new Client(t);
    await fresh.signIn(addr);
    expect((await fresh.session()).body.organization).toBeNull();
  });

  it("is not moved by another device's session refreshing its expiry (review of #208, 2)", async () => {
    onTestFinished(() => void vi.useRealTimers());
    const t0 = Date.parse('2026-11-20T09:00:00Z');
    vi.setSystemTime(t0);
    const t = testApp();
    const addr = email('two-devices');
    const { c: laptop, ids } = await memberOf(t, addr, ['Laptop', 'Phone']);
    expect((await laptop.setActive(ids[0]!)).status).toBe(200);
    vi.setSystemTime(t0 + 60_000);
    const phone = new Client(t);
    await phone.signIn(addr);
    expect((await phone.setActive(ids[1]!)).status).toBe(200);

    // Two days on, past Better Auth's one-day update age: the laptop's next read refreshes its
    // session's expiry, its org unchanged.
    vi.setSystemTime(t0 + 2 * 24 * 3_600_000);
    const laptopSession = () =>
      env.DB.prepare('SELECT expiresAt FROM session s JOIN user u ON u.id = s.userId WHERE u.email = ? ORDER BY s.createdAt LIMIT 1')
        .bind(addr)
        .first('expiresAt');
    const before = await laptopSession();
    expect((await laptop.session()).body.organization).toEqual({ id: ids[0], role: 'owner' });
    expect(await laptopSession()).not.toBe(before);

    const next = new Client(t);
    await next.signIn(addr);
    expect((await next.session()).body.organization).toEqual({ id: ids[1], role: 'owner' });
  });

  it('is the org a session chose last, even one it was already on (re-check of #208)', async () => {
    const t = testApp();
    const addr = email('re-pick');
    const { c: laptop, ids } = await memberOf(t, addr, ['Laptop', 'Phone']);
    expect((await laptop.setActive(ids[0]!)).status).toBe(200);
    const phone = new Client(t);
    await phone.signIn(addr);
    expect((await phone.setActive(ids[1]!)).status).toBe(200);
    // The laptop, still on its org, chooses it again: the latest choice.
    expect((await laptop.setActive(ids[0]!)).status).toBe(200);

    const next = new Client(t);
    await next.signIn(addr);
    expect((await next.session()).body.organization).toEqual({ id: ids[0], role: 'owner' });
  });

  it('never stores an org whose membership ends between its read and the session insert (review of #208, 1)', async () => {
    const t = testApp();
    const addr = email('revoked');
    const { ids } = await memberOf(t, addr, ['Only']);
    const leave = await secondOwner(t, ids[0]!);
    // The membership is deleted right after the hook reads it, before Better Auth inserts the session.
    let revoked = false;
    const revokeAfterRead = (sql: string) => async () => {
      if (revoked || !/lastActiveOrganizationId/.test(sql) || !/"member"/.test(sql)) return;
      revoked = true;
      await leave.run();
    };
    const racing = new Client(t, undefined, { ...env, DB: racingD1(revokeAfterRead) });
    await racing.signIn(addr);
    expect(revoked).toBe(true);

    const stored = await env.DB.prepare(
      'SELECT s.activeOrganizationId AS org FROM session s JOIN user u ON u.id = s.userId WHERE u.email = ? ORDER BY s.createdAt DESC LIMIT 1',
    )
      .bind(addr)
      .first('org');
    expect(stored).toBeNull();
    // The cookie the sign-in set may still name the org (Better Auth issues it from the insert's
    // values); every request checks membership again, so it reaches nothing.
    expect((await racing.session()).body.organization).toBeNull();
    const refused = await racing.tool('list_screens');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'not_a_member' });
  });
});

/** The D1 binding, running `after(sql)()` once each statement prepared from `sql` has run. */
function racingD1(after: (sql: string) => () => Promise<void>): D1Database {
  const wrap = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== 'function' || !['all', 'raw', 'first', 'run'].includes(String(key))) return value;
        return async (...args: unknown[]) => {
          const result: unknown = await value.apply(target, args);
          await after(sql)();
          return result;
        };
      },
    });
  return new Proxy(env.DB, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
