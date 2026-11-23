// Member tools (#108) against real Better Auth, through `/api/tools`: an owner changes the team, an
// editor is refused, the last owner stays, each change is audited once as the CMS's own call is,
// and an owner of two orgs reaches only the active one's rows.
import { scoped } from '@signforge/db';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { Client, email, testApp } from './client';

async function team() {
  const t = testApp();
  const owner = new Client(t);
  const { user } = await owner.signIn(email('owner'));
  const org = await owner.createOrg('Team Tools');
  const addr = email('editor');
  const invite = await owner.ok<{ id: string }>('/api/auth/organization/invite-member', { email: addr, role: 'editor' });
  const editor = new Client(t);
  await editor.signIn(addr);
  const { member } = await editor.ok<{ member: { id: string } }>('/api/auth/organization/accept-invitation', { invitationId: invite.id });
  const ownerMember = (await scoped(env.DB, org.id).members.list()).find((m) => m.userId === user.id)!;
  return { t, owner, ownerId: user.id, org, editor, editorMemberId: member.id, ownerMemberId: ownerMember.id };
}

const body = async (res: Response) => ({ status: res.status, ...((await res.json()) as Record<string, unknown>) });
/** The org's audit rows for one action, oldest first, with their detail parsed. */
const audits = async (orgId: string, action: string) =>
  (await scoped(env.DB, orgId).auditLog.list({ limit: 200 }))
    .filter((e) => e.action === action)
    .reverse()
    .map((e) => ({
      actorKind: e.actorKind,
      actorId: e.actorId,
      clientId: e.clientId,
      targetKind: e.targetKind,
      targetId: e.targetId,
      detail: JSON.parse(e.detailJson!),
    }));

describe('an owner, through the member tools', () => {
  it('lists the members and invitations, invites, cancels, changes a role and removes a member', async () => {
    const { t, owner, org, editorMemberId } = await team();
    const members = await body(await owner.tool('list_members'));
    expect(members).toMatchObject({ status: 200, members: [{ role: 'owner' }, { id: editorMemberId, role: 'editor' }], next: null });

    const addr = email('invitee');
    const invited = await body(await owner.tool('invite_member', { email: addr, role: 'viewer' }));
    expect(invited).toMatchObject({ status: 200, invitation: { email: addr, role: 'viewer', status: 'pending' } });
    // Better Auth sends the invitation, as for the CMS's own call.
    expect(t.outbox.last(addr)?.subject).toBe('Join Team Tools on SignForge');
    const { id: invitationId } = invited.invitation as { id: string };
    expect(await body(await owner.tool('list_invitations'))).toMatchObject({ invitations: [{ id: invitationId, email: addr }] });
    expect(await body(await owner.tool('cancel_invitation', { invitationId }))).toMatchObject({ status: 200, canceled: invitationId });
    expect(await body(await owner.tool('list_invitations'))).toMatchObject({ invitations: [] });

    expect(await body(await owner.tool('update_member_role', { memberId: editorMemberId, role: 'viewer' }))).toMatchObject({
      status: 200,
      member: { id: editorMemberId, role: 'viewer' },
    });
    expect(await body(await owner.tool('remove_member', { memberId: editorMemberId }))).toMatchObject({ status: 200, removed: editorMemberId });
    expect((await scoped(env.DB, org.id).members.list()).map((m) => m.role)).toEqual(['owner']);
  });

  it('cannot demote or remove the last owner', async () => {
    const { owner, org, ownerMemberId } = await team();
    expect(await body(await owner.tool('update_member_role', { memberId: ownerMemberId, role: 'editor' }))).toMatchObject({ status: 409, error: 'conflict' });
    expect(await body(await owner.tool('remove_member', { memberId: ownerMemberId }))).toMatchObject({ status: 409, error: 'conflict' });
    expect(await scoped(env.DB, org.id).members.get(ownerMemberId)).toMatchObject({ role: 'owner' });
  });

  it('is told a conflict for an address already invited', async () => {
    const { owner } = await team();
    const addr = email('twice');
    expect((await owner.tool('invite_member', { email: addr, role: 'viewer' })).status).toBe(200);
    expect(await body(await owner.tool('invite_member', { email: addr, role: 'viewer' }))).toMatchObject({ status: 409, error: 'conflict' });
  });
});

describe('an editor, through the member tools', () => {
  it('lists the members and is refused every change', async () => {
    const { editor, org, ownerMemberId } = await team();
    expect((await editor.tool('list_members')).status).toBe(200);
    for (const [name, input] of [
      ['list_invitations', {}],
      ['invite_member', { email: email('x'), role: 'viewer' }],
      ['update_member_role', { memberId: ownerMemberId, role: 'viewer' }],
      ['remove_member', { memberId: ownerMemberId }],
    ] as const) {
      expect((await editor.tool(name, input)).status, name).toBe(403);
    }
    expect(await scoped(env.DB, org.id).members.get(ownerMemberId)).toMatchObject({ role: 'owner' });
  });
});

describe('the audit row of a member change', () => {
  it('is one per change, the same as the CMS’s own call writes', async () => {
    const { owner, org, ownerId, editorMemberId } = await team();
    // The same changes, once through the tools and once through Better Auth's endpoints as the CMS calls them.
    const byTool = email('by-tool');
    const byEndpoint = email('by-endpoint');
    await owner.tool('invite_member', { email: byTool, role: 'viewer' });
    await owner.ok('/api/auth/organization/invite-member', { email: byEndpoint, role: 'viewer' });
    await owner.tool('update_member_role', { memberId: editorMemberId, role: 'viewer' });
    await owner.ok('/api/auth/organization/update-member-role', { memberId: editorMemberId, role: 'editor' });

    const invites = await audits(org.id, 'invite_member');
    // The first is team()'s own invitation of the editor.
    expect(invites.slice(1)).toEqual([
      {
        actorKind: 'user',
        actorId: ownerId,
        clientId: 'cms',
        targetKind: 'invitation',
        targetId: expect.any(String),
        detail: { email: byTool, role: 'viewer' },
      },
      {
        actorKind: 'user',
        actorId: ownerId,
        clientId: 'cms',
        targetKind: 'invitation',
        targetId: expect.any(String),
        detail: { email: byEndpoint, role: 'viewer' },
      },
    ]);
    const roles = await audits(org.id, 'update_member_role');
    expect(roles).toEqual([
      {
        actorKind: 'user',
        actorId: ownerId,
        clientId: 'cms',
        targetKind: 'member',
        targetId: editorMemberId,
        detail: { userId: expect.any(String), role: 'viewer' },
      },
      {
        actorKind: 'user',
        actorId: ownerId,
        clientId: 'cms',
        targetKind: 'member',
        targetId: editorMemberId,
        detail: { userId: expect.any(String), role: 'editor' },
      },
    ]);
  });
});

describe('an owner of two orgs', () => {
  it("reaches only the active org's members and invitations, though Better Auth would let them manage both", async () => {
    const { owner, org: first, editorMemberId } = await team();
    const pending = await owner.ok<{ id: string }>('/api/auth/organization/invite-member', { email: email('first'), role: 'viewer', organizationId: first.id });
    // Creating the second org makes it the session's active org.
    const second = await owner.createOrg('Second Team');
    expect((await owner.session()).body.organization).toMatchObject({ id: second.id, role: 'owner' });
    for (const [name, input] of [
      ['cancel_invitation', { invitationId: pending.id }],
      ['update_member_role', { memberId: editorMemberId, role: 'viewer' }],
      ['remove_member', { memberId: editorMemberId }],
    ] as const) {
      expect(await body(await owner.tool(name, input)), name).toMatchObject({ status: 404, error: 'not_found' });
    }
    expect(await scoped(env.DB, first.id).members.get(editorMemberId)).toMatchObject({ role: 'editor' });
    expect(await scoped(env.DB, first.id).invitations.get(pending.id)).toMatchObject({ status: 'pending' });
    expect((await body(await owner.tool('list_members'))).members).toHaveLength(1);
  });
});
