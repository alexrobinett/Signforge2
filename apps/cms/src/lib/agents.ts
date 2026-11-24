/**
 * Settings › API & agents (M4-07, the SettingsApi and AgentDetail boards): connected agents as the
 * grant tools return them, the tool reference, each tool with its scope and role, and each agent's
 * calls over the last 7 days in words (M4-08, `get_agent_grant_usage`).
 */
import type { ToolErrorCode, ToolOutput } from '@signforge/tools/outputs';
import { CONNECT_SCOPES, type ConnectScope } from './connect';
import { ago } from './screen-status';

/** A connected agent: its grant, with its client as a page may name it. */
export type AgentGrant = ToolOutput<'list_agent_grants'>['grants'][number];

/** An agent's calls over the last 7 days, as /mcp recorded them. */
export type AgentUsage = ToolOutput<'get_agent_grant_usage'>['grants'][number];
/** One recorded call: what it called and how it ended, never what it was given. */
export type AgentCall = ToolOutput<'get_agent_grant_usage'>['recent'][number];

const ROLES = ['viewer', 'editor', 'owner'] as const;

/** A tool as the reference lists it: what an agent may be granted to call. */
export interface AgentTool {
  name: string;
  scope: ConnectScope;
  minRole: (typeof ROLES)[number];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `GET /api/tools`' answer, read where it enters: each tool's name, scope and least role. */
export function parseAgentTools(body: unknown): AgentTool[] {
  if (!isRecord(body) || !Array.isArray(body.tools)) throw new Error('The tool list has no tools.');
  return body.tools.map((t: unknown) => {
    const scope = isRecord(t) ? CONNECT_SCOPES.find((s) => s === t.scope) : undefined;
    const minRole = isRecord(t) ? ROLES.find((r) => r === t.minRole) : undefined;
    if (!isRecord(t) || typeof t.name !== 'string' || !scope || !minRole) throw new Error('The tool list has a tool without a name, scope or role.');
    return { name: t.name, scope, minRole };
  });
}

/** When it was granted: "12 Nov", the same on the server and in the browser. */
export const grantedOn = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** The hour's granularity of `last_used_at` (written at most hourly by /mcp). */
const HOUR = 60 * 60_000;

/** When it last called, as /mcp records it: to the hour, so "This hour" rather than a time it cannot know. */
export function lastActive(lastUsedAt: number | null, now: number): string {
  if (lastUsedAt === null) return 'Never';
  return now - lastUsedAt < HOUR ? 'This hour' : `${ago(now - lastUsedAt)} ago`;
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** The list's "Last 7 days": "12 calls · 3 changes". */
export const weekWords = (u: Pick<AgentUsage, 'calls' | 'changes'>) => `${count(u.calls, 'call', 'calls')} · ${count(u.changes, 'change', 'changes')}`;

/** How a call ended, in words: a refusal (forbidden or rate_limited) as the ticket words it, with what a forbidden call needed. */
export function outcome(call: AgentCall): string {
  if (call.result === 'ok') return call.change ? 'Changed' : 'Read';
  if (call.result === 'forbidden') return call.needs ? `Refused · Needs ${call.needs}` : 'Refused';
  // A code newer than this page's words: it did not go through.
  return RESULT_WORDS[call.result] ?? 'Failed';
}

/** Every other ending's words; the call log's text is looked up here, so any string may come. */
const RESULT_WORDS: Record<string, string> = {
  rate_limited: 'Refused · Over its limit',
  not_found: 'Not found',
  invalid_input: 'Input not valid',
  conflict: 'Changed since it read it',
  sample_text: 'Refused · Sample text left',
  unknown_tool: 'No such tool',
  unavailable: 'Failed',
  error: 'Failed',
} satisfies Record<Exclude<ToolErrorCode, 'forbidden'> | 'error', string>;
