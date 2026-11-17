/**
 * Membership lookups on Better Auth's `member` table. Not a tenant query: it answers which org a
 * user may act in, before there is a scope. `apps/api` uses it to re-check the active org on
 * every request.
 */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { member, organization } from './schema';

/** The user's membership of the org, or undefined if they are not a member. */
export async function findMembership(d1: D1Database, orgId: string, userId: string): Promise<{ role: string } | undefined> {
  return drizzle(d1)
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .get();
}

/** Whether an organization exists. The deploy-secret tree checks the org it is told to write to. */
export async function organizationExists(d1: D1Database, orgId: string): Promise<boolean> {
  return (await drizzle(d1).select({ id: organization.id }).from(organization).where(eq(organization.id, orgId)).get()) !== undefined;
}
