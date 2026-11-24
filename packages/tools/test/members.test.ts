// Member tools (#108): who may call them, what an agent may do, and that a change asks Better
// Auth (`Members`, faked here) only about a row of the caller's org. The changes themselves, with
// Better Auth's rules and audit rows, are tested in apps/api/test/member-tools.test.ts. Cancelling
// writes through the org's scope with no session, so an agent may cancel; inviting is a person's (#321).
import { scoped, type Write } from '@signforge/db';
import { seedOrg, seedTeam, type SeededOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { dispatch, registry, ROLES, type AgentLimiter, type Caller, type Members, type Role, type Scope } from '../src';
import { outputs } from '../src/outputs';
import { racing } from './calls';
import { fakeServices } from './services';

let o: SeededOrg;
let other: SeededOrg;
let inviter: string;
beforeAll(async () => {
  o = await seedOrg(env.DB, 'members-org');
  other = await seedOrg(env.DB, 'members-other');
  inviter = (await seedTeam(env.DB, o.orgId)).userId;
  await seedTeam(env.DB, other.orgId);
});

let invitations = 0;
/** A pending invitation of the org's, of its own: a cancel really cancels one. */
async function pending() {
  const id = `${o.orgId}-inv-${++invitations}`;
  const now = new Date(0).toISOString();
  await env.DB.prepare(
    "INSERT INTO invitation (id, organizationId, email, role, status, expiresAt, createdAt, inviterId) VALUES (?, ?, ?, 'viewer', 'pending', ?, ?, ?)",
  )
    .bind(id, o.orgId, `${id}@signforge.test`, new Date(Date.UTC(2100, 0)).toISOString(), now, inviter)
    .run();
  return id;
}
const statusOf = async (id: string) => (await scoped(env.DB, o.orgId).invitations.get(id))?.status;

/** A `Members` that records what it is asked. */
function recorder() {
  const asked: unknown[][] = [];
  const members: Members = {
    invite: async (email, role) => {
      asked.push(['invite', email, role]);
      return fakeServices.members.invite(email, role);
    },
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
    const id = await pending();
    expect(await dispatch(registry, 'cancel_invitation', { invitationId: id }, owner)).toEqual({
      ok: true,
      output: { canceled: id, email: `${id}@signforge.test` },
    });
    expect(await statusOf(id)).toBe('canceled');
    expect(await dispatch(registry, 'update_member_role', { memberId: member(), role: 'owner' }, owner)).toMatchObject({
      ok: true,
      output: { member: { id: member(), role: 'owner' } },
    });
    expect(await dispatch(registry, 'remove_member', { memberId: member() }, owner)).toEqual({ ok: true, output: { removed: member() } });
    expect(asked).toEqual([
      ['invite', 'sam@example.com', 'owner'],
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

  it('lists and cancels a pending invitation, as its member, audited as the agent with its client (#321)', async () => {
    const { asked, members } = recorder();
    const agent = as('owner', members, manager);
    expect((await dispatch(registry, 'list_members', {}, agent)).ok).toBe(true);
    expect((await dispatch(registry, 'list_invitations', {}, agent)).ok).toBe(true);
    const id = await pending();
    expect(await dispatch(registry, 'cancel_invitation', { invitationId: id }, agent)).toMatchObject({ ok: true, output: { canceled: id } });
    expect(await statusOf(id)).toBe('canceled');
    const [row] = await scoped(env.DB, o.orgId).auditLog.list({ limit: 1 });
    expect(row).toMatchObject({
      action: 'cancel_invitation',
      actorKind: 'agent',
      actorId: 'agt_members',
      clientId: 'agent-app',
      targetKind: 'invitation',
      targetId: id,
    });
    expect(JSON.parse(row!.detailJson!).detail).toEqual({ email: `${id}@signforge.test` });
    // Cancelled already, or another org's: not found, and nothing changes there.
    expect(await dispatch(registry, 'cancel_invitation', { invitationId: id }, agent)).toMatchObject({ ok: false, error: 'not_found' });
    expect(await dispatch(registry, 'cancel_invitation', { invitationId: `${other.orgId}-invitation` }, agent)).toMatchObject({
      ok: false,
      error: 'not_found',
    });
    expect(await scoped(env.DB, other.orgId).invitations.get(`${other.orgId}-invitation`)).toMatchObject({ status: 'pending' });
    expect(asked).toEqual([]);
  });

  it('cancels nothing once its member is no longer an owner, nor one accepted between its read and its batch', async () => {
    const { members } = recorder();
    const id = await pending();
    expect(await dispatch(registry, 'cancel_invitation', { invitationId: id }, as('editor', members, manager))).toMatchObject({
      ok: false,
      error: 'forbidden',
    });
    const base = as('owner', members, manager);
    const org = base.org as typeof base.org & { commit: (w: readonly Write[]) => Promise<unknown> };
    let raced = false;
    const racing = {
      ...base,
      org: new Proxy(org, {
        get: (t, k) =>
          k === 'commit'
            ? async (writes: readonly Write[]) => {
                if (!raced) {
                  raced = true;
                  await env.DB.prepare("UPDATE invitation SET status = 'accepted' WHERE id = ?").bind(id).run();
                }
                return org.commit(writes);
              }
            : Reflect.get(t, k),
      }),
    };
    expect(await dispatch(registry, 'cancel_invitation', { invitationId: id }, racing)).toMatchObject({
      ok: false,
      error: 'conflict',
      message: expect.stringContaining('accepted, rejected or cancelled meanwhile'),
    });
    expect(await statusOf(id)).toBe('accepted');
  });

  it('cancels nothing when its member is made an editor between its read and its batch: forbidden, not a conflict (review of #414)', async () => {
    const { members } = recorder();
    const id = await pending();
    // Another owner first, as the org must keep one.
    const now = new Date(0).toISOString();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)').bind(
        `${o.orgId}-second`,
        'Second',
        `${o.orgId}-second@signforge.test`,
        now,
        now,
      ),
      env.DB.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', ?)").bind(
        `${o.orgId}-member-2`,
        o.orgId,
        `${o.orgId}-second`,
        now,
      ),
    ]);
    const setRole = (role: Role) => env.DB.prepare('UPDATE member SET role = ? WHERE id = ?').bind(role, member()).run();
    const demoted = racing({ ...as('owner', members, manager), member: inviter }, () => setRole('editor'));
    try {
      expect(await dispatch(registry, 'cancel_invitation', { invitationId: id }, demoted)).toMatchObject({ ok: false, error: 'forbidden' });
    } finally {
      await setRole('owner');
    }
    expect(await statusOf(id)).toBe('pending');
  });

  it('never invites, changes a role or removes a member', async () => {
    const { asked, members } = recorder();
    const agent = as('owner', members, manager);
    // Inviting is a person's (#321): refused whatever the role.
    for (const role of ['viewer', 'editor', 'owner'] as const)
      expect(await dispatch(registry, 'invite_member', { email: `${role}@example.com`, role }, agent), role).toMatchObject({
        ok: false,
        error: 'forbidden',
        message: 'invite_member is for people only: a person does it in the CMS',
      });
    expect(await dispatch(registry, 'update_member_role', { memberId: member(), role: 'viewer' }, agent)).toMatchObject({ ok: false, error: 'forbidden' });
    expect(await dispatch(registry, 'remove_member', { memberId: member() }, agent)).toMatchObject({ ok: false, error: 'forbidden' });
    expect(asked).toEqual([]);
  });

  it('refuses the in-CMS agent too, which acts as an owner but is an agent (re-check of #280)', async () => {
    const { asked, members } = recorder();
    const cmsAgent: Caller = { ...as('owner', members), actor: { kind: 'user', id: 'user-owner', clientId: 'cms-agent' } };
    expect(await dispatch(registry, 'invite_member', { email: 'sam@example.com', role: 'viewer' }, cmsAgent)).toMatchObject({
      ok: false,
      error: 'forbidden',
      message: 'invite_member is for people only: a person does it in the CMS',
    });
    expect(await dispatch(registry, 'update_member_role', { memberId: member(), role: 'viewer' }, cmsAgent)).toMatchObject({ ok: false, error: 'forbidden' });
    expect(await dispatch(registry, 'remove_member', { memberId: member() }, cmsAgent)).toMatchObject({ ok: false, error: 'forbidden' });
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
