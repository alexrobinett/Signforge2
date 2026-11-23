/**
 * Where agent grants are written and ended (./agent-grants.ts's `GrantDeps`), through packages/db's
 * scoped repository, each change with its audit row in one batch, the person as the actor.
 */
import { AGENT_GRANT_IDLE_MS, findMembership, scoped } from '@signforge/db';
import { effectiveScopes, grantOf, ROLES, type Role } from '@signforge/tools';
import type { GrantDeps } from './agent-grants';

/** A grant's changes come from the CMS: consent and membership changes are a person's. */
const CMS_CLIENT_ID = 'cms';

const isRole = (r: string): r is Role => ROLES.some((role) => role === r);

type Org = ReturnType<typeof scoped>;

/** A grant revoked by `by` (with the provider's tokens), and its audit row saying why. */
const revoking = (org: Org, grant: NonNullable<Awaited<ReturnType<Org['agentGrants']['get']>>>, by: string, detail: Record<string, string>) => [
  ...org.agentGrants.stage.revoke(grant, by, Date.now()).writes,
  ...org.auditLog.stage({
    actorKind: 'user',
    actorId: by,
    clientId: CMS_CLIENT_ID,
    action: 'revoke_agent_grant',
    targetKind: 'agent_grant',
    targetId: grant.id,
    detailJson: JSON.stringify(detail),
  }).writes,
];

export function grantStore(d1: D1Database): GrantDeps {
  return {
    create: async ({ orgId, userId, clientId, clientName, scopes }) => {
      const membership = await findMembership(d1, orgId, userId);
      if (!membership || !isRole(membership.role)) return { ok: false, refused: 'not_a_member' };
      const org = scoped(d1, orgId);
      // Within the member's role as the org has it now (editorsPublish); the dispatcher caps again on every call.
      const granted = effectiveScopes(await grantOf({ org, role: membership.role, scopes }));
      if (!granted.length) return { ok: false, refused: 'no_scopes' };
      const made = org.agentGrants.stage.insert({
        userId,
        clientId,
        clientName,
        scopesJson: JSON.stringify(granted),
        expiresAt: Date.now() + AGENT_GRANT_IDLE_MS,
      });
      const audit = org.auditLog.stage({
        actorKind: 'user',
        actorId: userId,
        clientId: CMS_CLIENT_ID,
        action: 'create_agent_grant',
        targetKind: 'agent_grant',
        targetId: made.row.id,
        detailJson: JSON.stringify({ clientId, clientName, scopes: granted }),
      });
      await org.commit([...made.writes, ...audit.writes]);
      return { ok: true, grantId: made.row.id, scopes: granted };
    },
    revokeMember: async (orgId, userId, by) => {
      const org = scoped(d1, orgId);
      const grants = await org.agentGrants.unrevokedFor(userId);
      if (grants.length) await org.commit(grants.flatMap((g) => revoking(org, g, by, { reason: 'membership_ended', userId })));
    },
    revokeUnissued: async (orgId, grantId, by) => {
      const org = scoped(d1, orgId);
      const grant = await org.agentGrants.get(grantId);
      if (grant) await org.commit(revoking(org, grant, by, { reason: 'no_code_issued' }));
    },
  };
}
