/**
 * Settings › API & agents (M4-07): the agents connected to the org, as the signed-in member may see
 * them (an owner every grant, anyone else their own), the tools with their scope and role, each
 * agent's last 7 days of calls (M4-08), and one agent's recent calls and changes. Reads through the
 * tool registry and Better Auth's member list; changes go from the browser (src/state/settings.ts).
 */
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { type AgentTool, parseAgentTools } from '~/lib/agents';
import { detailText, whatText } from '~/lib/audit';
import type { Member } from '~/lib/settings';
import { Refusal } from '~/lib/tools';
import { callApi } from './api.server';
import { all, inOrg, tool } from './tools.server';

/** Members' names by user id, for who granted each agent. */
async function names(): Promise<Record<string, string>> {
  const res = await callApi('/api/auth/organization/list-members?limit=200');
  if (!res.ok) throw new Error(`member list failed: ${res.status}`);
  // Better Auth's answer (better-auth 1.7.25, pinned), as the other settings pages read it.
  const { members }: { members: Member[] } = await res.json();
  return Object.fromEntries(members.map((m) => [m.userId, m.user.name || m.user.email]));
}

/** The tools this member may use, with each one's scope and role: what an agent they connect could be granted. */
async function tools(): Promise<AgentTool[]> {
  const res = await callApi('/api/tools');
  if (!res.ok) throw new Error(`tool list failed: ${res.status}`);
  return parseAgentTools(await res.json());
}

/**
 * The agents' calls, or null where they cannot be read: a deployed API without its Analytics
 * Engine token (refused `forbidden`), or the SQL API failing just now (`unavailable`). The pages
 * then say the numbers are not available, and the rest still shows.
 */
async function usage(grantId?: string) {
  try {
    return await tool('get_agent_grant_usage', grantId ? { grantId } : {});
  } catch (err) {
    if (err instanceof Refusal && (err.code === 'forbidden' || err.code === 'unavailable')) return null;
    throw err;
  }
}

/** Where agents connect: `/mcp` on this host, as the OAuth issuer is. */
const mcpUrl = () => `${new URL(getRequest().url).origin}/mcp`;

export const getAgents = createServerFn({ method: 'GET' }).handler(() =>
  inOrg(
    async () => {
      const [grants, toolList, people, calls] = await Promise.all([all('list_agent_grants', (p) => p.grants), tools(), names(), usage()]);
      const week = calls && Object.fromEntries(calls.grants.map((u) => [u.grantId, u]));
      return { grants, tools: toolList, names: people, week, mcpUrl: mcpUrl(), at: Date.now() };
    },
    { grants: [], tools: [], names: {}, week: null, mcpUrl: '', at: 0 },
  ),
);

/** One agent, its last 7 days of calls, its recent changes (the audit log's rows for it, in words), and the scopes this member holds. */
export const getAgent = createServerFn({ method: 'GET' })
  .validator((grantId: unknown) => {
    if (typeof grantId !== 'string' || !/^agt_[\w-]{1,64}$/.test(grantId)) throw new Error('not an agent grant id');
    return grantId;
  })
  .handler(async ({ data: grantId }) => {
    const found = await tool('get_agent_grant', { grantId }, { missing: 'null' });
    if (!found) return null;
    const [{ entries }, toolList, people, calls] = await Promise.all([
      tool('list_audit_log', { actor: { kind: 'agent', id: grantId }, limit: 10 }),
      tools(),
      names(),
      usage(grantId),
    ]);
    // In words here: an entry's detail is whatever its tool was given.
    const recent = entries.map((e) => ({ at: e.at, action: e.action, what: whatText(e), detail: detailText(e) }));
    const week = calls && { usage: calls.grants[0]!, calls: calls.recent, lastRefusal: calls.lastRefusal };
    return { grant: found.grant, recent, week, mine: [...new Set(toolList.map((t) => t.scope))], names: people, at: Date.now() };
  });
