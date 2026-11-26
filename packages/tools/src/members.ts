/**
 * Member tools (#61, #108): an org's members and invitations, read from the org's scope, and an
 * invitation cancelled through it, audited by the dispatcher.
 *
 * Owner decisions (M4 plan, Q6; #321): an agent may list members, and list and cancel invitations.
 * Inviting, role changes and removals are people's: who joins is a person's choice, and a misled agent
 * could otherwise lock people out. No tool does them (#345): the CMS calls Better Auth's organization
 * endpoints, whose rules hold (one of our roles each; D1 keeps an owner, #292) and whose after hook
 * audits each change (apps/api src/auth/options.ts), and those endpoints take no agent's token.
 */
import type { OrgScope } from '@signforge/db';
import { z } from 'zod';
import { id } from './fields';
import { page, pageInput } from './paging';
import { defineTool, notFound, ROLES, type Role, ToolError } from './tool';
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

const cancelInvitation = defineTool({
  name: 'cancel_invitation',
  description:
    "Cancel a pending invitation, so its link no longer works; owners only, and an agent too, as its member (owner decision on #321). Refused as not found for one that is not this organization's or no longer pending, and with a conflict if it is accepted or cancelled meanwhile. Only a person invites again. Returns { canceled, email }.",
  scope: 'org:manage',
  minRole: 'owner',
  mutates: true,
  input: z.object({ invitationId: id('invitation') }),
  output: outputs.cancel_invitation,
  example: { invitationId: 'inv_0123456789abcdef' },
  target: (input) => ({ kind: 'invitation', id: input.invitationId }),
  // Who it was for, as Better Auth's own cancel records it.
  auditDetail: (output) => ({ email: output.email }),
  // No Better Auth session (an agent has none): this org's invitation, cancelled through its scope, held pending to the batch.
  handler: async ({ org, input, write }) => {
    const invitation = await org.invitations.get(input.invitationId);
    if (invitation?.status !== 'pending') throw notFound('pending invitation', input.invitationId);
    write(org.invitations.stage.cancel(invitation.id));
    return { canceled: invitation.id, email: invitation.email };
  },
  refuseFailedCommit: async ({ org, input }) =>
    (await org.invitations.get(input.invitationId))?.status === 'pending'
      ? undefined
      : new ToolError('conflict', `invitation ${input.invitationId} was accepted, rejected or cancelled meanwhile`),
});

export const memberTools = [listMembers, listInvitations, cancelInvitation];
