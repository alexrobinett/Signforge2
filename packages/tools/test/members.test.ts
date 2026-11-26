// Member tools (#108): who may call them and what an agent may do. Cancelling writes through the org's
// scope with no session, so an agent may cancel. Inviting, role changes and removals are a person's, in
// the CMS through Better Auth (apps/api/test/members.test.ts): no tool does them (#321, #345).
import { scoped, type Write } from '@signforge/db';
import { seedOrg, seedTeam, type SeededOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { dispatch, registry, ROLES, type AgentLimiter, type Caller, type Role, type Scope } from '../src';
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

const unlimited: AgentLimiter = { take: async () => ({ ok: true }), audited: async () => {} };
const as = (role: Role, agent?: { scopes: Scope[] }): Caller => ({
  org: scoped(env.DB, o.orgId),
  role,
  actor: agent ? { kind: 'agent', id: 'agt_members', clientId: 'agent-app' } : { kind: 'user', id: `user-${role}`, clientId: 'cms' },
  blobs: env.BLOBS,
  services: fakeServices,
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
  it('lists the members and pending invitations, and cancels one', async () => {
    const owner = as('owner');
    expect(await dispatch(registry, 'list_members', {}, owner)).toMatchObject({
      ok: true,
      output: { members: [{ id: member(), name: `${o.orgId} owner`, role: 'owner' }], next: null },
    });
    expect(await dispatch(registry, 'list_invitations', {}, owner)).toMatchObject({
      ok: true,
      output: { invitations: [{ id: invitation(), role: 'viewer', status: 'pending' }], next: null },
    });
    const id = await pending();
    expect(await dispatch(registry, 'cancel_invitation', { invitationId: id }, owner)).toEqual({
      ok: true,
      output: { canceled: id, email: `${id}@signforge.test` },
    });
    expect(await statusOf(id)).toBe('canceled');
  });

  it("is told not_found for another org's invitation", async () => {
    const owner = as('owner');
    for (const [tool, input] of [['cancel_invitation', { invitationId: `${other.orgId}-invitation` }]] as const) {
      expect(await dispatch(registry, tool, input, owner), tool).toMatchObject({ ok: false, error: 'not_found' });
    }
  });
});

describe('an editor and a viewer', () => {
  it('see the members, and nothing else', async () => {
    for (const role of ['editor', 'viewer'] as const) {
      const c = as(role);
      expect((await dispatch(registry, 'list_members', {}, c)).ok, role).toBe(true);
      for (const [tool, input] of [
        ['list_invitations', {}],
        ['cancel_invitation', { invitationId: invitation() }],
      ] as const) {
        expect(await dispatch(registry, tool, input, c), `${role} ${tool}`).toMatchObject({ ok: false, error: 'forbidden' });
      }
    }
  });
});

describe("an owner's agent", () => {
  const manager = { scopes: ['content:read', 'org:manage'] satisfies Scope[] };

  it('lists and cancels a pending invitation, as its member, audited as the agent with its client (#321)', async () => {
    const agent = as('owner', manager);
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
  });

  it('cancels nothing once its member is no longer an owner, nor one accepted between its read and its batch', async () => {
    const id = await pending();
    expect(await dispatch(registry, 'cancel_invitation', { invitationId: id }, as('editor', manager))).toMatchObject({
      ok: false,
      error: 'forbidden',
    });
    const base = as('owner', manager);
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
    const demoted = racing({ ...as('owner', manager), member: inviter }, () => setRole('editor'));
    try {
      expect(await dispatch(registry, 'cancel_invitation', { invitationId: id }, demoted)).toMatchObject({ ok: false, error: 'forbidden' });
    } finally {
      await setRole('owner');
    }
    expect(await statusOf(id)).toBe('pending');

    // Demoted, and the invitation accepted too, both meanwhile: still forbidden, never masked as a conflict (#417).
    const both = racing({ ...as('owner', manager), member: inviter }, async () => {
      await setRole('editor');
      await env.DB.prepare("UPDATE invitation SET status = 'accepted' WHERE id = ?").bind(id).run();
    });
    try {
      expect(await dispatch(registry, 'cancel_invitation', { invitationId: id }, both)).toMatchObject({
        ok: false,
        error: 'forbidden',
        message: expect.stringContaining('at least the owner role'),
      });
    } finally {
      await setRole('owner');
    }
    expect(await statusOf(id)).toBe('accepted');
  });

  it('never invites, changes a role or removes a member: no tool does, for it or the in-CMS agent (#321, #345)', async () => {
    const cmsAgent: Caller = { ...as('owner'), actor: { kind: 'user', id: 'user-owner', clientId: 'cms-agent' } };
    for (const caller of [as('owner', manager), cmsAgent])
      for (const [tool, input] of [
        ['invite_member', { email: 'sam@example.com', role: 'viewer' }],
        ['update_member_role', { memberId: member(), role: 'viewer' }],
        ['remove_member', { memberId: member() }],
      ] as const)
        expect(await dispatch(registry, tool, input, caller), tool).toMatchObject({ ok: false, error: 'unknown_tool' });
  });

  it('without org:manage, only lists the members', async () => {
    const reader = as('owner', { scopes: ['content:read'] });
    expect((await dispatch(registry, 'list_members', {}, reader)).ok).toBe(true);
    expect(await dispatch(registry, 'list_invitations', {}, reader)).toMatchObject({ ok: false, error: 'forbidden' });
  });
});
