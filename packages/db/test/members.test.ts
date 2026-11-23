// An org's members and invitations (#108), read through its scope: each org sees only its own.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { scoped } from '../src/index';
import { seedOrganization, seedTeam } from '../src/testing';

let a: Awaited<ReturnType<typeof seedTeam>>;
let b: Awaited<ReturnType<typeof seedTeam>>;
beforeAll(async () => {
  await seedOrganization(env.DB, 'team-a');
  await seedOrganization(env.DB, 'team-b');
  a = await seedTeam(env.DB, 'team-a');
  b = await seedTeam(env.DB, 'team-b');
});

describe("an org's members", () => {
  it('lists its own members with their name, address and role, and gets one', async () => {
    const team = scoped(env.DB, 'team-a');
    expect(await team.members.list()).toEqual([
      { id: a.member, userId: a.userId, name: 'team-a owner', email: 'team-a-owner@signforge.test', role: 'owner', createdAt: expect.any(String) },
    ]);
    expect(await team.members.get(a.member)).toMatchObject({ id: a.member, role: 'owner' });
  });

  it("finds nothing of another org's", async () => {
    const team = scoped(env.DB, 'team-a');
    expect(await team.members.get(b.member)).toBeUndefined();
    expect((await team.members.list()).map((m) => m.id)).not.toContain(b.member);
  });
});

describe("an org's invitations", () => {
  it('lists its pending ones and gets one', async () => {
    const team = scoped(env.DB, 'team-a');
    expect(await team.invitations.pending()).toEqual([
      expect.objectContaining({ id: a.invitation, email: 'team-a-invitee@signforge.test', role: 'viewer', status: 'pending' }),
    ]);
    expect(await team.invitations.get(a.invitation)).toMatchObject({ id: a.invitation, inviterId: a.userId });
  });

  it("finds nothing of another org's", async () => {
    const team = scoped(env.DB, 'team-a');
    expect(await team.invitations.get(b.invitation)).toBeUndefined();
    expect((await team.invitations.pending()).map((i) => i.id)).not.toContain(b.invitation);
  });

  it('lists no invitation that is no longer pending', async () => {
    await env.DB.prepare("UPDATE invitation SET status = 'canceled' WHERE id = ?").bind(b.invitation).run();
    expect(await scoped(env.DB, 'team-b').invitations.pending()).toEqual([]);
    expect(await scoped(env.DB, 'team-b').invitations.get(b.invitation)).toMatchObject({ status: 'canceled' });
  });
});
