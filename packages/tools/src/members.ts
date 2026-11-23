/**
 * Member tools (#61, #108): an org's members and invitations. Reads come from the org's scope; changes
 * go through Better Auth's organization endpoints (`Members`), so its rules hold (one of our roles
 * each, never without an owner) and its after hook writes each change's one audit row, with the
 * same action names as these tools. They stage nothing, so the dispatcher writes no second row.
 *
 * Owner decision (M4 plan, Q6): an agent may list members, list and cancel invitations, and invite
 * as a viewer or an editor, never as an owner. Role changes and removals are people's: a misled
 * agent could otherwise lock people out. Every change checks first that the row is in the caller's
 * org, since Better Auth would act on a row of any org the person may manage.
 */
import type { OrgScope } from '@signforge/db';
import { z } from 'zod';
import { id } from './fields';
import { page, pageInput } from './paging';
import { type Actor, defineTool, notFound, ROLES, type Role, ToolError } from './tool';
import { outputs } from './outputs';

const roleOf = (role: string | null): Role => z.enum(ROLES).parse(role);

type MemberRow = NonNullable<Awaited<ReturnType<OrgScope['members']['get']>>>;
const memberView = (m: MemberRow) => ({ ...m, role: roleOf(m.role) });

type InvitationRow = NonNullable<Awaited<ReturnType<OrgScope['invitations']['get']>>>;
const invitationView = (i: InvitationRow) => ({
  id: i.id,
  email: i.email,
  role: roleOf(i.role),
  status: z.literal('pending').parse(i.status),
  expiresAt: i.expiresAt,
  inviterId: i.inviterId,
  createdAt: i.createdAt,
});

async function requireMember(org: OrgScope, memberId: string) {
  const row = await org.members.get(memberId);
  if (!row) throw notFound('member', memberId);
  return row;
}

const refuseAgent = (actor: Actor, what: string) => {
  if (actor.kind === 'agent') throw new ToolError('forbidden', `an agent cannot ${what}: ask an owner to do it in the CMS`);
};

const role = z.enum(ROLES).describe('One role per member: owner, editor or viewer');

const listMembers = defineTool({
  name: 'list_members',
  description: "List the organization's members with their name, address and role, oldest first, a page at a time. Returns { members, next }.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ ...pageInput }),
  output: outputs.list_members,
  example: {},
  handler: async ({ org, input }) => {
    const { rows, next } = page(await org.members.list(), (m) => [m.createdAt, m.id], input);
    return { members: rows.map(memberView), next };
  },
});

const listInvitations = defineTool({
  name: 'list_invitations',
  description: "List the organization's pending invitations, oldest first, a page at a time; owners only. Returns { invitations, next }.",
  scope: 'org:manage',
  minRole: 'owner',
  mutates: false,
  input: z.object({ ...pageInput }),
  output: outputs.list_invitations,
  example: {},
  handler: async ({ org, input }) => {
    const { rows, next } = page(await org.invitations.pending(), (i) => [i.createdAt, i.id], input);
    return { invitations: rows.map(invitationView), next };
  },
});

const inviteMember = defineTool({
  name: 'invite_member',
  description:
    'Invite someone to the organization by email, with a role; owners only. They get an email with a link to accept. An agent may invite only a viewer or an editor. Returns { invitation }.',
  scope: 'org:manage',
  minRole: 'owner',
  mutates: true,
  needs: ['members'],
  input: z.object({ email: z.email().max(254), role }),
  output: outputs.invite_member,
  example: { email: 'sam@example.com', role: 'editor' },
  handler: async ({ actor, input, services: { members } }) => {
    if (actor.kind === 'agent' && input.role === 'owner') throw new ToolError('forbidden', 'an agent may invite only a viewer or an editor');
    return { invitation: await members.invite(input.email, input.role) };
  },
});

const cancelInvitation = defineTool({
  name: 'cancel_invitation',
  description: 'Cancel a pending invitation, so its link no longer works; owners only. Returns { canceled }.',
  scope: 'org:manage',
  minRole: 'owner',
  mutates: true,
  needs: ['members'],
  input: z.object({ invitationId: id('invitation') }),
  output: outputs.cancel_invitation,
  example: { invitationId: 'inv_0123456789abcdef' },
  handler: async ({ org, input, services: { members } }) => {
    // The only org guard on this path: Better Auth cancels in the invitation's own org.
    if ((await org.invitations.get(input.invitationId))?.status !== 'pending') throw notFound('pending invitation', input.invitationId);
    await members.cancelInvitation(input.invitationId);
    return { canceled: input.invitationId };
  },
});

const updateMemberRole = defineTool({
  name: 'update_member_role',
  description:
    "Change a member's role to owner, editor or viewer; owners only, and never the organization's last owner away from owner. People only: an agent is refused. Returns { member }.",
  scope: 'org:manage',
  minRole: 'owner',
  mutates: true,
  needs: ['members'],
  input: z.object({ memberId: id('member'), role }),
  output: outputs.update_member_role,
  example: { memberId: 'mem_0123456789abcdef', role: 'viewer' },
  handler: async ({ org, actor, input, services: { members } }) => {
    refuseAgent(actor, "change a member's role");
    await requireMember(org, input.memberId);
    await members.updateRole(input.memberId, input.role);
    return { member: memberView(await requireMember(org, input.memberId)) };
  },
});

const removeMember = defineTool({
  name: 'remove_member',
  description: 'Remove a member from the organization; owners only, and never its last owner. People only: an agent is refused. Returns { removed }.',
  scope: 'org:manage',
  minRole: 'owner',
  mutates: true,
  needs: ['members'],
  input: z.object({ memberId: id('member') }),
  output: outputs.remove_member,
  example: { memberId: 'mem_0123456789abcdef' },
  handler: async ({ org, actor, input, services: { members } }) => {
    refuseAgent(actor, 'remove a member');
    await requireMember(org, input.memberId);
    await members.remove(input.memberId);
    return { removed: input.memberId };
  },
});

export const memberTools = [listMembers, listInvitations, inviteMember, cancelInvitation, updateMemberRole, removeMember];
