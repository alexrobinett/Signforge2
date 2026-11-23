/**
 * Agent grants across orgs (M4-04): the token check `/mcp` makes on every call, and the pruning of
 * clients nobody consented to. Everything else about a grant is the org's scope (`agentGrants`).
 */
import { and, eq, gt, isNull, lt, notInArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { agentGrants, member, oauthAccessToken, oauthClient, oauthConsent } from './schema';

/** A grant ends 90 days after it was last used (owner default on #109). */
export const AGENT_GRANT_IDLE_MS = 90 * 24 * 60 * 60_000;
/** A registered client nobody has consented to is pruned after a day. */
export const UNCONSENTED_CLIENT_MS = 24 * 60 * 60_000;
/** Clients registered ahead of time, which are never pruned. */
export const FIRST_PARTY_CLIENT_IDS = ['sf-cli'] as const;

/**
 * The grant an access token stands for at `now`, with the member's role in its org now, or undefined
 * if the token or its grant is not live. One statement: the token by its SHA-256 (base64url, as the
 * provider stores it), unrevoked, unexpired and issued for `resource`; its grant (its reference id),
 * unrevoked and unexpired; and the grant's user still a member of the grant's org. The org comes
 * from the grant alone, so a token reaches no other org; a token with no grant row is not live.
 */
export async function agentGrantForToken(d1: D1Database, tokenHash: string, resource: string, now: number) {
  const t = oauthAccessToken;
  const g = agentGrants;
  return drizzle(d1)
    .select({
      grantId: g.id,
      orgId: g.orgId,
      userId: g.userId,
      clientId: g.clientId,
      clientName: g.clientName,
      scopesJson: g.scopesJson,
      lastUsedAt: g.lastUsedAt,
      role: member.role,
    })
    .from(t)
    .innerJoin(g, eq(g.id, t.referenceId))
    .innerJoin(member, and(eq(member.organizationId, g.orgId), eq(member.userId, g.userId)))
    .where(
      and(
        eq(t.token, tokenHash),
        isNull(t.revoked),
        gt(t.expiresAt, new Date(now).toISOString()),
        sql`EXISTS (SELECT 1 FROM json_each(${t.resources}) WHERE value = ${resource})`,
        isNull(g.revokedAt),
        gt(g.expiresAt, now),
      ),
    )
    .get();
}

/**
 * Deletes clients registered over a day before `now` that nobody consented to, but the first-party
 * ones (registration abuse, owner default on #109). One statement, for the daily run. Returns how many.
 */
export async function pruneUnconsentedClients(d1: D1Database, now: number): Promise<number> {
  const db = drizzle(d1);
  const consented = db.select({ clientId: oauthConsent.clientId }).from(oauthConsent);
  const result = await db
    .delete(oauthClient)
    .where(
      and(
        lt(oauthClient.createdAt, new Date(now - UNCONSENTED_CLIENT_MS).toISOString()),
        notInArray(oauthClient.clientId, consented),
        notInArray(oauthClient.clientId, [...FIRST_PARTY_CLIENT_IDS]),
      ),
    )
    .run();
  return result.meta.changes;
}
