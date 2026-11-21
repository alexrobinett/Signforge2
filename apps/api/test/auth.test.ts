import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
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

  it("is a member's only org, from the cookie the sign-in sets", async () => {
    const t = testApp();
    const addr = email('one-org');
    const { ids } = await memberOf(t, addr, ['Solo']);
    const fresh = new Client(t);
    await fresh.signIn(addr);
    expect((await fresh.session()).body.organization).toEqual({ id: ids[0], role: 'owner' });
    // The tab check reads the same session: a tab on that org acts, one on another is refused.
    expect((await fresh.tool('list_screens', {}, { [TAB_ORG_HEADER]: ids[0]! })).status).toBe(200);
    expect((await fresh.tool('list_screens', {}, { [TAB_ORG_HEADER]: 'org_elsewhere' })).status).toBe(409);
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
    await env.DB.prepare('DELETE FROM member WHERE organizationId = ?').bind(ids[2]).run();

    const fresh = new Client(t);
    await fresh.signIn(addr);
    expect((await fresh.session()).body.organization).toBeNull();
  });
});
