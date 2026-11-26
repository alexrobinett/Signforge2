// Members, roles and org settings (M3-42): only an owner changes them, and no member can act above their role.
import { scoped } from '@signforge/db';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { Client, email, nextIp, testApp } from './client';

async function team() {
  const t = testApp();
  const owner = new Client(t);
  await owner.signIn(email('owner'));
  const org = await owner.createOrg('Roles Co');
  const join = async (role: 'editor' | 'viewer') => {
    const addr = email(role);
    const invite = await owner.ok<{ id: string }>('/api/auth/organization/invite-member', { email: addr, role });
    const c = new Client(t);
    const { user } = await c.signIn(addr);
    const { member } = await c.ok<{ member: { id: string } }>('/api/auth/organization/accept-invitation', { invitationId: invite.id });
    return { c, userId: user.id, memberId: member.id };
  };
  const editor = await join('editor');
  const viewer = await join('viewer');
  const members = await owner.get(`/api/auth/organization/list-members?organizationId=${org.id}`);
  const ownerMember = ((await members.json()) as { members: { id: string; role: string }[] }).members.find((m) => m.role === 'owner')!;
  return { t, owner, org, editor, viewer, ownerMemberId: ownerMember.id };
}

const role = async (c: Client) => (await c.session()).body.organization?.role;

describe('roles', () => {
  it('editors and viewers cannot raise their own role, or anyone else’s', async () => {
    const { owner, org, editor, viewer, ownerMemberId } = await team();
    for (const m of [editor, viewer]) {
      for (const to of ['owner', 'editor']) {
        const res = await m.c.post('/api/auth/organization/update-member-role', { memberId: m.memberId, role: to, organizationId: org.id });
        expect(res.status, `${await role(m.c)} -> ${to}`).toBe(403);
      }
      expect((await m.c.post('/api/auth/organization/update-member-role', { memberId: ownerMemberId, role: 'viewer', organizationId: org.id })).status).toBe(
        403,
      );
    }
    expect((await viewer.c.post('/api/auth/organization/update-member-role', { memberId: editor.memberId, role: 'viewer' })).status).toBe(403);
    expect(await role(editor.c)).toBe('editor');
    expect(await role(viewer.c)).toBe('viewer');
    expect(await role(owner)).toBe('owner');
  });

  it('editors and viewers cannot invite, cancel invitations or remove members', async () => {
    const { owner, editor, viewer } = await team();
    const pending = await owner.ok<{ id: string }>('/api/auth/organization/invite-member', { email: email('later'), role: 'viewer' });
    // Better Auth answers cancel and remove 401, not 403; either way they are refused.
    for (const m of [editor, viewer]) {
      for (const r of ['owner', 'editor', 'viewer']) {
        expect((await m.c.post('/api/auth/organization/invite-member', { email: email('x'), role: r })).status).toBe(403);
      }
      expect([401, 403]).toContain((await m.c.post('/api/auth/organization/cancel-invitation', { invitationId: pending.id })).status);
    }
    const invitations = (await (await owner.get('/api/auth/organization/list-invitations')).json()) as { id: string; status: string }[];
    expect(invitations.find((i) => i.id === pending.id)?.status).toBe('pending');
    expect([401, 403]).toContain((await editor.c.post('/api/auth/organization/remove-member', { memberIdOrEmail: viewer.memberId })).status);
    expect([401, 403]).toContain((await viewer.c.post('/api/auth/organization/remove-member', { memberIdOrEmail: editor.memberId })).status);
    expect(await role(editor.c)).toBe('editor');
    expect(await role(viewer.c)).toBe('viewer');
  });

  it('editors and viewers cannot rename the org or change its settings', async () => {
    const { org, editor, viewer } = await team();
    for (const m of [editor, viewer]) {
      expect((await m.c.post('/api/auth/organization/update', { organizationId: org.id, data: { name: 'Taken over' } })).status).toBe(403);
      expect((await m.c.tool('update_org_settings', { unreachableAfterMinutes: 60 })).status).toBe(403);
      expect((await m.c.tool('get_org_settings')).status).toBe(200);
    }
    // A viewer changes nothing at all.
    expect((await viewer.c.tool('save_group', { name: 'Mine' })).status).toBe(403);
  });

  it('an owner changes roles, removes members and settings; the removed member is out at once', async () => {
    const { owner, org, editor, viewer, ownerMemberId } = await team();
    expect((await owner.post('/api/auth/organization/update-member-role', { memberId: viewer.memberId, role: 'editor' })).status).toBe(200);
    expect(await role(viewer.c)).toBe('editor');
    expect((await owner.post('/api/auth/organization/update', { organizationId: org.id, data: { name: 'Roles Co Ltd' } })).status).toBe(200);
    expect((await owner.tool('update_org_settings', { timezone: 'Europe/Paris' })).status).toBe(200);

    expect((await owner.post('/api/auth/organization/remove-member', { memberIdOrEmail: editor.memberId })).status).toBe(200);
    expect((await editor.c.tool('list_screens')).status).toBe(403);

    // The only owner cannot step down and leave the org without one.
    expect((await owner.post('/api/auth/organization/update-member-role', { memberId: ownerMemberId, role: 'editor' })).status).toBe(400);
    expect(await role(owner)).toBe('owner');
  });
});

/**
 * The bindings, with the first statement that changes a `member` row held until `release`: a request
 * made with them stops after Better Auth's checks, just before its write, while another runs.
 */
function holdingMemberWrite() {
  let reached = () => {};
  const atWrite = new Promise<void>((r) => {
    reached = r;
  });
  let release = () => {};
  const released = new Promise<void>((r) => {
    release = r;
  });
  let held = false;
  const wait = async (sql: string) => {
    if (held || !/^\s*(update|delete\s+from)\s+["`]?member["`]?\s/i.test(sql)) return;
    held = true;
    reached();
    await released;
  };
  const statement = (sql: string, s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(target, key) {
        const v = Reflect.get(target, key);
        if (key === 'bind') return (...args: unknown[]) => statement(sql, target.bind(...args));
        if (typeof v !== 'function') return v;
        if (key === 'first' || key === 'run' || key === 'all' || key === 'raw') {
          return async (...args: unknown[]) => {
            await wait(sql);
            return v.apply(target, args);
          };
        }
        return v.bind(target);
      },
    });
  const DB = new Proxy(env.DB, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => statement(sql, target.prepare(sql));
      const v = Reflect.get(target, key);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { bindings: { ...env, DB }, atWrite, release };
}

describe('an org always keeps an owner (#292)', () => {
  /** An org with two owners, A and B, each signed in; A's requests can be held at their write. */
  async function twoOwners() {
    const t = testApp();
    const a = new Client(t);
    const { user: aUser } = await a.signIn(email('owner-a'));
    const org = await a.createOrg('Two Owners Co');
    const bAddr = email('owner-b');
    const invite = await a.ok<{ id: string }>('/api/auth/organization/invite-member', { email: bAddr, role: 'owner' });
    const b = new Client(t);
    const { user: bUser } = await b.signIn(bAddr);
    const { member: bMember } = await b.ok<{ member: { id: string } }>('/api/auth/organization/accept-invitation', { invitationId: invite.id });
    const aMember = (await scoped(env.DB, org.id).members.list()).find((m) => m.userId === aUser.id)!;
    const hold = holdingMemberWrite();
    const heldA = new Client(t, nextIp(), hold.bindings);
    for (const [k, v] of a.jar) heldA.jar.set(k, v);
    const owners = async () => (await scoped(env.DB, org.id).members.list()).filter((m) => m.role === 'owner').map((m) => m.userId);
    /** A's request runs to its write and waits there while B's runs to the end; then A's goes on. */
    const race = async (aCall: (c: Client) => Promise<Response>, bCall: (c: Client) => Promise<Response>) => {
      const aRes = aCall(heldA);
      await hold.atWrite;
      const bRes = await bCall(b);
      hold.release();
      return { a: await aRes, b: bRes };
    };
    const audit = async (action: string) => (await scoped(env.DB, org.id).auditLog.list()).filter((r) => r.action === action);
    return { org, a, b, aUser, bUser, aMember, bMember, owners, race, audit };
  }

  // The refusal a request gets when the other owner's change landed after Better Auth's own count.
  const lostRace = { code: 'ORGANIZATION_NEEDS_AN_OWNER', message: expect.stringContaining('at least one owner') };

  it('two owners demoting each other at once leaves exactly one owner', async () => {
    const { org, bUser, aMember, bMember, owners, race, audit } = await twoOwners();
    const res = await race(
      (a) => a.post('/api/auth/organization/update-member-role', { memberId: bMember.id, role: 'editor', organizationId: org.id }),
      (b) => b.post('/api/auth/organization/update-member-role', { memberId: aMember.id, role: 'editor', organizationId: org.id }),
    );
    expect(res.b.status).toBe(200);
    expect(res.a.status).toBe(400);
    expect(await res.a.json()).toMatchObject(lostRace);
    expect(await owners()).toEqual([bUser.id]);
    // Only the change that happened is in the log.
    expect((await audit('update_member_role')).map((r) => r.targetId)).toEqual([aMember.id]);
  });

  it('two owners removing each other at once leaves exactly one owner', async () => {
    const { org, bUser, aMember, bMember, owners, race, audit } = await twoOwners();
    const res = await race(
      (a) => a.post('/api/auth/organization/remove-member', { memberIdOrEmail: bMember.id, organizationId: org.id }),
      (b) => b.post('/api/auth/organization/remove-member', { memberIdOrEmail: aMember.id, organizationId: org.id }),
    );
    expect(res.b.status).toBe(200);
    expect(res.a.status).toBe(400);
    expect(await res.a.json()).toMatchObject(lostRace);
    expect(await owners()).toEqual([bUser.id]);
    expect((await audit('remove_member')).map((r) => r.targetId)).toEqual([aMember.id]);
  });

  it('two owners leaving at once leaves exactly one owner', async () => {
    const { org, aUser, bMember, owners, race, audit } = await twoOwners();
    const res = await race(
      (a) => a.post('/api/auth/organization/leave', { organizationId: org.id }),
      (b) => b.post('/api/auth/organization/leave', { organizationId: org.id }),
    );
    expect(res.b.status).toBe(200);
    expect(res.a.status).toBe(400);
    expect(await res.a.json()).toMatchObject(lostRace);
    expect(await owners()).toEqual([aUser.id]);
    expect((await audit('leave_organization')).map((r) => r.targetId)).toEqual([bMember.id]);
  });

  it('refuses the last owner stepping down, leaving or being removed, with a clear error', async () => {
    const { org, a, b, aUser, aMember, owners } = await twoOwners();
    await b.ok('/api/auth/organization/leave', { organizationId: org.id });
    for (const [path, body] of [
      ['/api/auth/organization/update-member-role', { memberId: aMember.id, role: 'editor', organizationId: org.id }],
      ['/api/auth/organization/remove-member', { memberIdOrEmail: aMember.id, organizationId: org.id }],
      ['/api/auth/organization/leave', { organizationId: org.id }],
    ] as const) {
      const res = await a.post(path, body);
      expect(res.status, path).toBe(400);
      expect(((await res.json()) as { message: string }).message, path).toMatch(/owner/);
    }
    expect(await owners()).toEqual([aUser.id]);
  });
});

describe('the audit log', () => {
  it('records each membership change made through Better Auth, with its actor and target', async () => {
    const t = testApp();
    const owner = new Client(t);
    const { user: ownerUser } = await owner.signIn(email('owner'));
    const org = await owner.createOrg('Audited Co');
    // Creating the org still makes it active at once (the cache cookie is reissued).
    expect((await owner.session()).body.organization).toEqual({ id: org.id, role: 'owner' });
    const listed = (await (await owner.get(`/api/auth/organization/list-members?organizationId=${org.id}`)).json()) as { members: { id: string }[] };
    const ownerMemberId = listed.members[0]!.id;
    const addr = email('joiner');
    const invite = await owner.ok<{ id: string }>('/api/auth/organization/invite-member', { email: addr, role: 'viewer' });
    const joiner = new Client(t);
    const { user: joinerUser } = await joiner.signIn(addr);
    const { member } = await joiner.ok<{ member: { id: string } }>('/api/auth/organization/accept-invitation', { invitationId: invite.id });
    const later = await owner.ok<{ id: string }>('/api/auth/organization/invite-member', { email: email('later'), role: 'viewer' });
    await owner.ok('/api/auth/organization/cancel-invitation', { invitationId: later.id });
    await owner.ok('/api/auth/organization/update-member-role', { memberId: member.id, role: 'editor' });
    // A refused change leaves no row.
    expect((await joiner.post('/api/auth/organization/update', { organizationId: org.id, data: { name: 'Taken over' } })).status).toBe(403);
    await owner.ok('/api/auth/organization/update', { organizationId: org.id, data: { name: 'Audited Co Ltd' } });
    await owner.ok('/api/auth/organization/remove-member', { memberIdOrEmail: member.id });

    const rows = await scoped(env.DB, org.id).auditLog.list();
    const by = (u: { id: string }) => ({ actorKind: 'user', actorId: u.id, clientId: 'cms' });
    const order = (a: { action: string; targetId: string | null }, b: { action: string; targetId: string | null }) =>
      a.action.localeCompare(b.action) || String(a.targetId).localeCompare(String(b.targetId));
    expect(
      rows
        .map((r) => ({ action: r.action, actorKind: r.actorKind, actorId: r.actorId, clientId: r.clientId, targetKind: r.targetKind, targetId: r.targetId }))
        .sort(order),
    ).toEqual(
      [
        { action: 'accept_invitation', ...by(joinerUser), targetKind: 'member', targetId: member.id },
        { action: 'create_organization', ...by(ownerUser), targetKind: 'member', targetId: ownerMemberId },
        { action: 'cancel_invitation', ...by(ownerUser), targetKind: 'invitation', targetId: later.id },
        { action: 'invite_member', ...by(ownerUser), targetKind: 'invitation', targetId: invite.id },
        { action: 'invite_member', ...by(ownerUser), targetKind: 'invitation', targetId: later.id },
        { action: 'remove_member', ...by(ownerUser), targetKind: 'member', targetId: member.id },
        { action: 'update_member_role', ...by(ownerUser), targetKind: 'member', targetId: member.id },
        { action: 'update_organization', ...by(ownerUser), targetKind: 'organization', targetId: org.id },
      ].sort(order),
    );
    const detail = (action: string) => JSON.parse(rows.find((r) => r.action === action)?.detailJson ?? 'null');
    expect(detail('create_organization')).toEqual({ userId: ownerUser.id, role: 'owner', name: 'Audited Co', slug: org.slug });
    expect(detail('update_member_role')).toEqual({ userId: joinerUser.id, role: 'editor' });
    expect(detail('remove_member')).toEqual({ userId: joinerUser.id, role: 'editor' });
  });

  it('records an invitee turning an invitation down and a member leaving, as that person', async () => {
    const t = testApp();
    const owner = new Client(t);
    await owner.signIn(email('owner'));
    const org = await owner.createOrg('Audited Too');
    const join = async (who: string) => {
      const addr = email(who);
      const invite = await owner.ok<{ id: string }>('/api/auth/organization/invite-member', { email: addr, role: 'viewer' });
      const c = new Client(t);
      const { user } = await c.signIn(addr);
      return { c, user, invite };
    };
    const no = await join('no');
    await no.c.ok('/api/auth/organization/reject-invitation', { invitationId: no.invite.id });
    const yes = await join('yes');
    const { member } = await yes.c.ok<{ member: { id: string } }>('/api/auth/organization/accept-invitation', { invitationId: yes.invite.id });
    await yes.c.ok('/api/auth/organization/leave', { organizationId: org.id });

    const rows = await scoped(env.DB, org.id).auditLog.list();
    const row = (action: string) => rows.find((r) => r.action === action);
    expect(row('reject_invitation')).toMatchObject({ actorId: no.user.id, targetKind: 'invitation', targetId: no.invite.id });
    expect(row('leave_organization')).toMatchObject({ actorId: yes.user.id, targetKind: 'member', targetId: member.id });
  });

  it('records only what each change needs, never org metadata, which can hold secrets', async () => {
    const t = testApp();
    const owner = new Client(t);
    await owner.signIn(email('owner'));
    const SECRET = 'sk-live-not-for-the-audit-log';
    const metadata = { integrations: { feed: { token: SECRET } } };
    const slug = `secretive-${Math.random().toString(36).slice(2, 8)}`;
    const org = await owner.ok<{ id: string }>('/api/auth/organization/create', { name: 'Secretive', slug, metadata });
    await owner.ok('/api/auth/organization/update', { organizationId: org.id, data: { name: 'Secretive Ltd', metadata } });
    await owner.ok('/api/auth/organization/invite-member', { email: email('new'), role: 'viewer' });

    const rows = await scoped(env.DB, org.id).auditLog.list();
    const detail = (action: string) => JSON.parse(rows.find((r) => r.action === action)?.detailJson ?? 'null');
    expect(detail('update_organization')).toEqual({ name: 'Secretive Ltd', slug, changed: ['name', 'metadata'] });
    expect(detail('invite_member')).toEqual({ email: expect.stringContaining('new-'), role: 'viewer' });
    for (const r of rows) expect(r.detailJson).not.toContain(SECRET);
  });
});

describe('list_audit_log over /api/tools', () => {
  it("gives an invitee's email to owners only, as Better Auth lists invitations to owners only", async () => {
    const { owner, editor, viewer } = await team();
    const invites = async (c: Client) => {
      const res = await c.tool('list_audit_log', { action: 'invite_member' });
      expect(res.status).toBe(200);
      return ((await res.json()) as { entries: { detail: Record<string, unknown> }[] }).entries.map((e) => e.detail);
    };
    expect(await invites(owner)).toEqual([
      { email: expect.stringContaining('viewer-'), role: 'viewer' },
      { email: expect.stringContaining('editor-'), role: 'editor' },
    ]);
    for (const m of [editor, viewer]) {
      expect((await m.c.get('/api/auth/organization/list-invitations')).status).toBe(403);
      expect(await invites(m.c)).toEqual([{ role: 'viewer' }, { role: 'editor' }]);
    }
  });

  it("refuses a cursor from the org the member switched away from, so no page mixes two orgs' rows", async () => {
    const { owner } = await team();
    const first = await owner.tool('list_audit_log', { limit: 1 });
    const { next } = (await first.json()) as { next: string };
    expect(next).toBeTruthy();
    await owner.createOrg('Second Co');
    const res = await owner.tool('list_audit_log', { limit: 1, cursor: next });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_input', message: expect.stringContaining('another organization') });
  });
});
