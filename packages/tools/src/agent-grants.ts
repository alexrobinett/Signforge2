/**
 * Agent grant tools (M4-07): what people see and change of the agents connected to their org, on
 * Settings › API & agents. A grant (M4-04) is one member's, in one org, for one OAuth client.
 *
 * - Who sees a grant: an owner, every grant in the org; anyone else, their own.
 * - Who changes one: the member who granted it may raise or lower its scopes, within what they may
 *   do themselves now; an owner may lower or revoke any. Nobody raises another person's grant.
 * - People only (`people`): an agent, a grant's or the in-CMS one, never manages grants, or it could
 *   widen or keep its own; the dispatcher refuses it, and `/mcp` does not list these tools.
 *
 * A change applies on the agent's next `/mcp` call, which reads the grant fresh; a revoke also
 * deletes the provider's tokens for it (`stage.revoke`), so its next call gets 401 and its refresh
 * is refused. Clients are named as `/connect` names them (`shownClient`).
 */
import type { AgentGrantRow, OrgScope } from '@signforge/db';
import { z } from 'zod';
import { shownClient } from './agent-clients';
import { id, ifVersion } from './fields';
import { outputs, SCOPES, type AgentGrantView } from './outputs';
import { page, pageInput } from './paging';
import { type Actor, defineTool, notFound, type Role, type Scope, ToolError } from './tool';

const grantId = id('agent grant');

/** The scopes a grant row holds, in the registry's order. Written only by consent and these tools, from `SCOPES`. */
const scopesOf = (row: AgentGrantRow): Scope[] => {
  const granted: unknown = JSON.parse(row.scopesJson);
  return SCOPES.filter((s) => Array.isArray(granted) && granted.includes(s));
};

function grantView({ grant, redirectUrisJson }: { grant: AgentGrantRow; redirectUrisJson: string }): AgentGrantView {
  // The provider's own JSON for the client's registered redirects; a client registers at least one.
  const redirects: unknown = JSON.parse(redirectUrisJson);
  const first = Array.isArray(redirects) ? redirects[0] : undefined;
  if (typeof first !== 'string') throw new Error(`client ${grant.clientId} has no redirect URI`);
  return {
    id: grant.id,
    client: shownClient(grant.clientId, grant.clientName, first),
    scopes: scopesOf(grant),
    grantedBy: grant.userId,
    createdAt: grant.createdAt,
    lastUsedAt: grant.lastUsedAt,
    expiresAt: grant.expiresAt,
    version: grant.rowVersion,
  };
}

/** Whose grants the caller sees: an owner's org's every one, anyone else's own. */
const visibleTo = (role: Role, actor: Actor) => (role === 'owner' ? {} : { userId: actor.id });

/** The connected grant, if the caller may see it; not found otherwise, as another org's would be. */
async function requireGrant(org: OrgScope, role: Role, actor: Actor, grantId: string) {
  const [row] = await org.agentGrants.connected({ ...visibleTo(role, actor), grantId });
  if (!row) throw notFound('agent grant', grantId);
  return row;
}

const target = (input: { grantId: string }) => ({ kind: 'agent_grant', id: input.grantId });

const listAgentGrants = defineTool({
  name: 'list_agent_grants',
  description:
    "List the agents connected to the organization, newest first, a page at a time: for an owner every member's, for anyone else their own. Each says its client, its scopes, who granted it and when it last called. People only. Returns { grants, next }.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  people: true,
  input: z.object({ ...pageInput }),
  output: outputs.list_agent_grants,
  example: {},
  handler: async ({ org, actor, role, input }) => {
    const rows = await org.agentGrants.connected(visibleTo(role, actor));
    const { rows: shown, next } = page(rows, (r) => [-r.grant.createdAt, r.grant.id], input);
    return { grants: shown.map(grantView), next };
  },
});

const getAgentGrant = defineTool({
  name: 'get_agent_grant',
  description: 'Get one connected agent: its client, scopes, who granted it and when it last called. People only. Returns { grant }.',
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  people: true,
  input: z.object({ grantId }),
  output: outputs.get_agent_grant,
  example: { grantId: 'agt_example' },
  handler: async ({ org, actor, role, input }) => {
    return { grant: grantView(await requireGrant(org, role, actor, input.grantId)) };
  },
});

const updateAgentGrantScopes = defineTool({
  name: 'update_agent_grant_scopes',
  description:
    "Set a connected agent's scopes, from its next call. The member who granted it may add or remove scopes, up to what they may do themselves now; an owner may only remove scopes from someone else's. content:read is always on. People only. Pass the version you read as ifVersion. Returns { grant }.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: true,
  people: true,
  input: z.object({
    grantId,
    scopes: z
      .array(z.enum(SCOPES))
      .min(1)
      .max(SCOPES.length)
      .describe('Every scope it should hold, content:read among them: the whole set, replacing the grant’s'),
    ifVersion,
  }),
  output: outputs.update_agent_grant_scopes,
  example: { grantId: 'agt_example', scopes: ['content:read', 'content:draft'], ifVersion: 1 },
  target,
  handler: async ({ org, actor, role, scopes: mine, input, write }) => {
    const row = await requireGrant(org, role, actor, input.grantId);
    const wanted = SCOPES.filter((s) => input.scopes.includes(s));
    if (!wanted.includes('content:read')) throw new ToolError('invalid_input', 'content:read is always on: an agent can do nothing without it');
    if (row.grant.userId === actor.id) {
      const beyond = wanted.filter((s) => !mine.includes(s));
      if (beyond.length) throw new ToolError('forbidden', `you may grant only what you may do yourself: not ${beyond.join(', ')}`);
    } else {
      const raised = wanted.filter((s) => !scopesOf(row.grant).includes(s));
      if (raised.length) throw new ToolError('forbidden', `only the member who granted it may add scopes: not ${raised.join(', ')}`);
    }
    const grant = write(org.agentGrants.stage.update(row.grant, { scopesJson: JSON.stringify(wanted) }, input.ifVersion));
    return { grant: grantView({ ...row, grant }) };
  },
});

const revokeAgentGrant = defineTool({
  name: 'revoke_agent_grant',
  description:
    'Disconnect an agent: its grant ends and its tokens are deleted, so its next call is refused and it must ask a person again. Your own grant, or as an owner anyone’s. People only. Returns { revoked }.',
  scope: 'content:read',
  minRole: 'viewer',
  mutates: true,
  people: true,
  input: z.object({ grantId }),
  output: outputs.revoke_agent_grant,
  example: { grantId: 'agt_example' },
  target,
  handler: async ({ org, actor, role, input, write }) => {
    const { grant } = await requireGrant(org, role, actor, input.grantId);
    write(org.agentGrants.stage.revoke(grant, actor.id, Date.now()));
    return { revoked: grant.id };
  },
});

export const agentGrantTools = [listAgentGrants, getAgentGrant, updateAgentGrantScopes, revokeAgentGrant];
