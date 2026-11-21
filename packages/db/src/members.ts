/**
 * Membership lookups on Better Auth's `member` table. Not a tenant query: it answers which org a
 * user may act in, before there is a scope. `apps/api` uses it to re-check the active org on
 * every request.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { member, organization, user } from './schema';

/** The user's membership of the org, or undefined if they are not a member. */
export async function findMembership(d1: D1Database, orgId: string, userId: string): Promise<{ role: string } | undefined> {
  return drizzle(d1)
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .get();
}

/** The names of those orgs the user is a member of, by id: an org they are not in stays unnamed. */
export async function memberOrgNames(d1: D1Database, userId: string, orgIds: string[]): Promise<Map<string, string>> {
  const rows = await drizzle(d1)
    .select({ id: organization.id, name: organization.name })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(and(eq(member.userId, userId), inArray(member.organizationId, orgIds)))
    .all();
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * The org a new session starts in (#182): the user's only org, or the one they last made active
 * while they are still its member; otherwise none, and the CMS asks which.
 */
export async function startingOrg(d1: D1Database, userId: string): Promise<string | null> {
  const rows = await drizzle(d1)
    .select({ orgId: member.organizationId, last: user.lastActiveOrganizationId })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.userId, userId))
    .all();
  if (rows.length === 1) return rows[0]!.orgId;
  return rows.find((r) => r.orgId === r.last)?.orgId ?? null;
}

/** Records the org the user made active, for `startingOrg`. */
export async function rememberActiveOrg(d1: D1Database, userId: string, orgId: string): Promise<void> {
  await drizzle(d1).update(user).set({ lastActiveOrganizationId: orgId }).where(eq(user.id, userId)).run();
}

/** Whether an organization exists. The deploy-secret tree checks the org it is told to write to. */
export async function organizationExists(d1: D1Database, orgId: string): Promise<boolean> {
  return (await drizzle(d1).select({ id: organization.id }).from(organization).where(eq(organization.id, orgId)).get()) !== undefined;
}

/** The org's members with their address and role, for sending them alerts. */
export async function orgMembers(d1: D1Database, orgId: string): Promise<{ userId: string; email: string; name: string; role: string }[]> {
  return drizzle(d1)
    .select({ userId: member.userId, email: user.email, name: user.name, role: member.role })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, orgId))
    .all();
}
