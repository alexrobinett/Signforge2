/**
 * Agent grant tools (M4-07): what people see and change of the agents connected to their org, on
 * Settings › Connected agents (MCP). A grant (M4-04) is one member's, in one org, for one OAuth client.
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
import { shownClient } from './agent-clients';
import { outputs, SCOPES, type AgentGrantView } from './outputs';
import { page } from './paging';
import { type Actor, defineTool, notFound, type Role, type Scope, ToolError } from './tool';
import { inputs } from './inputs';

/** The scopes a grant row holds, in the registry's order. Written only by consent and these tools, from `SCOPES`. */
const scopesOf = (row: AgentGrantRow): Scope[] => {
  const granted: unknown = JSON.parse(row.scopesJson);
  return SCOPES.filter((s) => Array.isArray(granted) && granted.includes(s));
};

/** A connected grant's client as a page names it (`shownClient`), by the first redirect it registered. */
export function grantClient({ grant, redirectUrisJson }: { grant: AgentGrantRow; redirectUrisJson: string }) {
  // The provider's own JSON for the client's registered redirects; a client registers at least one.
  const redirects: unknown = JSON.parse(redirectUrisJson);
  const first = Array.isArray(redirects) ? redirects[0] : undefined;
  if (typeof first !== 'string') throw new Error(`client ${grant.clientId} has no redirect URI`);
  return shownClient(grant.clientId, grant.clientName, first);
}

function grantView({ grant, redirectUrisJson }: { grant: AgentGrantRow; redirectUrisJson: string }): AgentGrantView {
  return {
    id: grant.id,
    client: grantClient({ grant, redirectUrisJson }),
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
  input: inputs.list_agent_grants,
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
  input: inputs.get_agent_grant,
  output: outputs.get_agent_grant,
  example: { grantId: 'agt_example' },
  handler: async ({ org, actor, role, input }) => {
    return { grant: grantView(await requireGrant(org, role, actor, input.grantId)) };
  },
});

const updateAgentGrantScopes = defineTool({
  name: 'update_agent_grant_scopes',
  description:
    "Set a connected agent's scopes, from its next call. The member who granted it may add or remove scopes, up to what they may do themselves now; an owner may only remove scopes from someone else's. content:read is always on. People only. ifVersion, the version you read, is required. Returns { grant }.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: true,
  people: true,
  input: inputs.update_agent_grant_scopes,
  output: outputs.update_agent_grant_scopes,
  example: { grantId: 'agt_example', scopes: ['content:read', 'content:draft'], ifVersion: 1 },
  target,
  handler: async ({ org, actor, role, scopes: mine, input, write }) => {
    const row = await requireGrant(org, role, actor, input.grantId);
    const wanted = SCOPES.filter((s) => input.scopes.includes(s));
    if (!wanted.includes('content:read')) throw new ToolError('invalid_input', 'content:read is always on: an agent can do nothing without it');
    // Only what is added is checked: a scope it keeps may be above the granter's role now (they were
    // made an editor since), and lowering another must not wait for that.
    const added = wanted.filter((s) => !scopesOf(row.grant).includes(s));
    if (row.grant.userId === actor.id) {
      const beyond = added.filter((s) => !mine.includes(s));
      if (beyond.length) throw new ToolError('forbidden', `you may grant only what you may do yourself: not ${beyond.join(', ')}`);
    } else if (added.length) {
      throw new ToolError('forbidden', `only the member who granted it may add scopes: not ${added.join(', ')}`);
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
  input: inputs.revoke_agent_grant,
  output: outputs.revoke_agent_grant,
  example: { grantId: 'agt_example' },
  target,
  handler: async ({ org, actor, role, input, write }) => {
    const { grant } = await requireGrant(org, role, actor, input.grantId);
    write(org.agentGrants.stage.revoke(grant, actor.id, Date.now()));
    return { revoked: grant.id };
  },
});

/** The period a grant's numbers count (M4-08): the last 7 days. */
const WEEK_MS = 7 * 24 * 60 * 60_000;
/** How many of a grant's latest calls its page lists. */
const RECENT_CALLS = 20;

const getAgentGrantUsage = defineTool({
  name: 'get_agent_grant_usage',
  description:
    "How connected agents have been used over the last 7 days: each one's calls, changes, draft changes and refusals (refused forbidden or rate_limited), from the call log (never a call's input or output). With grantId, that agent's alone, with its latest calls, reads and refusals included, and its latest refusal. Without, every agent the caller may see: for an owner every member's, for anyone else their own. People only. Returns { since, grants, recent, lastRefusal }.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  people: true,
  needs: ['agentCalls'],
  input: inputs.get_agent_grant_usage,
  output: outputs.get_agent_grant_usage,
  example: { grantId: 'agt_example' },
  handler: async ({ org, actor, role, input, services: { agentCalls } }) => {
    const ids = input.grantId
      ? [(await requireGrant(org, role, actor, input.grantId)).grant.id]
      : (await org.agentGrants.connected(visibleTo(role, actor))).map((r) => r.grant.id);
    const since = Date.now() - WEEK_MS;
    const one = input.grantId;
    const [counted, recent, lastRefusal] = await Promise.all([
      ids.length ? agentCalls.usage(ids, since) : [],
      one ? agentCalls.recent(one, since, RECENT_CALLS) : [],
      one ? agentCalls.lastRefusal(one, since) : null,
    ]);
    // Every grant asked about, once: one with no calls is all zeros.
    const grants = ids.map((grantId) => counted.find((u) => u.grantId === grantId) ?? { grantId, calls: 0, changes: 0, drafts: 0, refusals: 0 });
    return { since, grants, recent, lastRefusal };
  },
});

export const agentGrantTools = [listAgentGrants, getAgentGrant, updateAgentGrantScopes, revokeAgentGrant, getAgentGrantUsage];
