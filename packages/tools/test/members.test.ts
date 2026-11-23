// Member tools (#108): who may call them, what an agent may do, and that a change asks Better
// Auth (`Members`, faked here) only about a row of the caller's org. The changes themselves, with
// Better Auth's rules and audit rows, are tested in apps/api/test/member-tools.test.ts.
import { scoped } from '@signforge/db';
import { seedOrg, seedTeam, type SeededOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { dispatch, registry, ROLES, type AgentLimiter, type Caller, type Members, type Role, type Scope } from '../src';
import { outputs } from '../src/outputs';
import { fakeServices } from './services';

let o: SeededOrg;
let other: SeededOrg;
beforeAll(async () => {
  o = await seedOrg(env.DB, 'members-org');
  other = await seedOrg(env.DB, 'members-other');
  await seedTeam(env.DB, o.orgId);
  await seedTeam(env.DB, other.orgId);
});

/** A `Members` that records what it is asked. */
function recorder() {
  const asked: unknown[][] = [];
  const members: Members = {
    invite: async (email, role) => {
      asked.push(['invite', email, role]);
      return fakeServices.members.invite(email, role);
    },
    cancelInvitation: async (id) => void asked.push(['cancelInvitation', id]),
    updateRole: async (id, role) => void asked.push(['updateRole', id, role]),
    remove: async (id) => void asked.push(['remove', id]),
  };
  return { asked, members };
}

const unlimited: AgentLimiter = { take: async () => ({ ok: true }), audited: async () => {} };
const as = (role: Role, members: Members, agent?: { scopes: Scope[] }): Caller => ({
  org: scoped(env.DB, o.orgId),
  role,
  actor: agent ? { kind: 'agent', id: 'agt_members', clientId: 'agent-app' } : { kind: 'user', id: `user-${role}`, clientId: 'cms' },
  blobs: env.BLOBS,
  services: { ...fakeServices, members },
  ...(agent ? { scopes: agent.scopes, agentLimiter: unlimited } : {}),
});

const member = () => `${o.orgId}-member`;
const invitation = () => `${o.orgId}-invitation`;

describe('the outputs', () => {
  it('name the roles ROLES has', () => {
    expect(outputs.list_members.shape.members.element.shape.role.options).toEqual([...ROLES]);
    expect(outputs.list_invitations.shape.invitations.element.shape.role.options).toEqual([...ROLES]);
  });
});

describe('an owner', () => {
  it('lists the members and pending invitations, and changes them through Better Auth', async () => {
    const { asked, members } = recorder();
    const owner = as('owner', members);
    expect(await dispatch(registry, 'list_members', {}, owner)).toMatchObject({
      ok: true,
      output: { members: [{ id: member(), name: `${o.orgId} owner`, role: 'owner' }], next: null },
    });
    expect(await dispatch(registry, 'list_invitations', {}, owner)).toMatchObject({
      ok: true,
      output: { invitations: [{ id: invitation(), role: 'viewer', status: 'pending' }], next: null },
    });
    expect(await dispatch(registry, 'invite_member', { email: 'sam@example.com', role: 'owner' }, owner)).toMatchObject({
      ok: true,
      output: { invitation: { email: 'sam@example.com', role: 'owner', status: 'pending' } },
    });
    expect(await dispatch(registry, 'cancel_invitation', { invitationId: invitation() }, owner)).toEqual({ ok: true, output: { canceled: invitation() } });
    expect(await dispatch(registry, 'update_member_role', { memberId: member(), role: 'owner' }, owner)).toMatchObject({
      ok: true,
      output: { member: { id: member(), role: 'owner' } },
    });
    expect(await dispatch(registry, 'remove_member', { memberId: member() }, owner)).toEqual({ ok: true, output: { removed: member() } });
    expect(asked).toEqual([
      ['invite', 'sam@example.com', 'owner'],
      ['cancelInvitation', invitation()],
      ['updateRole', member(), 'owner'],
      ['remove', member()],
    ]);
  });

  it("is told not_found for another org's member or invitation, and Better Auth is not asked", async () => {
    const { asked, members } = recorder();
    const owner = as('owner', members);
    for (const [tool, input] of [
      ['cancel_invitation', { invitationId: `${other.orgId}-invitation` }],
      ['update_member_role', { memberId: `${other.orgId}-member`, role: 'viewer' }],
      ['remove_member', { memberId: `${other.orgId}-member` }],
    ] as const) {
      expect(await dispatch(registry, tool, input, owner), tool).toMatchObject({ ok: false, error: 'not_found' });
    }
    expect(asked).toEqual([]);
  });
});

describe('an editor and a viewer', () => {
  it('see the members, and nothing else', async () => {
    const { asked, members } = recorder();
    for (const role of ['editor', 'viewer'] as const) {
      const c = as(role, members);
      expect((await dispatch(registry, 'list_members', {}, c)).ok, role).toBe(true);
      for (const [tool, input] of [
        ['list_invitations', {}],
        ['invite_member', { email: 'sam@example.com', role: 'viewer' }],
        ['cancel_invitation', { invitationId: invitation() }],
        ['update_member_role', { memberId: member(), role: 'owner' }],
        ['remove_member', { memberId: member() }],
      ] as const) {
        expect(await dispatch(registry, tool, input, c), `${role} ${tool}`).toMatchObject({ ok: false, error: 'forbidden' });
      }
    }
    expect(asked).toEqual([]);
  });
});

describe("an owner's agent", () => {
  const manager = { scopes: ['content:read', 'org:manage'] satisfies Scope[] };

  it('lists, invites a viewer or an editor, and cancels', async () => {
    const { asked, members } = recorder();
    const agent = as('owner', members, manager);
    expect((await dispatch(registry, 'list_members', {}, agent)).ok).toBe(true);
    expect((await dispatch(registry, 'list_invitations', {}, agent)).ok).toBe(true);
    for (const role of ['viewer', 'editor'] as const) {
      expect((await dispatch(registry, 'invite_member', { email: `${role}@example.com`, role }, agent)).ok, role).toBe(true);
    }
    expect((await dispatch(registry, 'cancel_invitation', { invitationId: invitation() }, agent)).ok).toBe(true);
    expect(asked).toEqual([
      ['invite', 'viewer@example.com', 'viewer'],
      ['invite', 'editor@example.com', 'editor'],
      ['cancelInvitation', invitation()],
    ]);
  });

  it('never invites an owner, changes a role or removes a member', async () => {
    const { asked, members } = recorder();
    const agent = as('owner', members, manager);
    expect(await dispatch(registry, 'invite_member', { email: 'boss@example.com', role: 'owner' }, agent)).toMatchObject({
      ok: false,
      error: 'forbidden',
      message: 'an agent may invite only a viewer or an editor',
    });
    expect(await dispatch(registry, 'update_member_role', { memberId: member(), role: 'viewer' }, agent)).toMatchObject({ ok: false, error: 'forbidden' });
    expect(await dispatch(registry, 'remove_member', { memberId: member() }, agent)).toMatchObject({ ok: false, error: 'forbidden' });
    expect(asked).toEqual([]);
  });

  it('without org:manage, only lists the members', async () => {
    const { asked, members } = recorder();
    const reader = as('owner', members, { scopes: ['content:read'] });
    expect((await dispatch(registry, 'list_members', {}, reader)).ok).toBe(true);
    expect(await dispatch(registry, 'list_invitations', {}, reader)).toMatchObject({ ok: false, error: 'forbidden' });
    expect(await dispatch(registry, 'invite_member', { email: 'x@example.com', role: 'viewer' }, reader)).toMatchObject({ ok: false, error: 'forbidden' });
    expect(asked).toEqual([]);
  });
});
