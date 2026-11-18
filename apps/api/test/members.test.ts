// Members, roles and org settings (M3-42): only an owner changes them, and no member can act above their role.
import { scoped } from '@signforge/db';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { Client, email, testApp } from './client';

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
    expect((await viewer.c.tool('create_group', { name: 'Mine' })).status).toBe(403);
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

describe('the audit log', () => {
  it('records each membership change made through Better Auth, with its actor and target', async () => {
    const t = testApp();
    const owner = new Client(t);
    const { user: ownerUser } = await owner.signIn(email('owner'));
    const org = await owner.createOrg('Audited Co');
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
        { action: 'cancel_invitation', ...by(ownerUser), targetKind: 'invitation', targetId: later.id },
        { action: 'invite_member', ...by(ownerUser), targetKind: 'invitation', targetId: invite.id },
        { action: 'invite_member', ...by(ownerUser), targetKind: 'invitation', targetId: later.id },
        { action: 'remove_member', ...by(ownerUser), targetKind: 'member', targetId: member.id },
        { action: 'update_member_role', ...by(ownerUser), targetKind: 'member', targetId: member.id },
        { action: 'update_organization', ...by(ownerUser), targetKind: 'organization', targetId: org.id },
      ].sort(order),
    );
    const detail = (action: string) => JSON.parse(rows.find((r) => r.action === action)?.detailJson ?? 'null');
    expect(detail('update_member_role')).toMatchObject({ input: { role: 'editor' }, result: { userId: joinerUser.id, role: 'editor' } });
    expect(detail('remove_member')).toMatchObject({ result: { userId: joinerUser.id } });
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
});
