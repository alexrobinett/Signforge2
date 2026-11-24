/**
 * Agents' calls over /mcp (M4-08): one Workers Analytics Engine data point each, written by the
 * adapter (src/mcp), and the reads Settings › API & agents makes of them (`get_agent_grant_usage`).
 * Owner decision on #113: Analytics Engine for calls, the audit log for changes. No D1 write per
 * call. Analytics Engine keeps data three months; the pages read the last 7 days.
 *
 * A data point holds what was called and how it ended, never its input, output or message:
 *   index1  the grant id (Analytics Engine samples per index, so per grant)
 *   blob1   the org id          blob2  the grant id        blob3  the OAuth client id
 *   blob4   the tool, or `(unknown)` for a name that is no tool (the agent chose it), or tools/list
 *   blob5   `ok`, a refusal's code, or `error`
 *   blob6   the scope the tool needs, '' for none
 *   blob7   a change's target kind, blob8 its id ('' for none)
 *   double1 the call's milliseconds, double2 1 for a tool that changes data
 *
 * Reading needs the SQL API, over HTTPS with an API token (Account Analytics: Read), which
 * `ANALYTICS_ACCOUNT_ID` and the `ANALYTICS_TOKEN` secret configure (src/env.d.ts). `wrangler dev`
 * has no SQL API to read, so in dev each call is also kept in this process, and read from there:
 * enough for local work and the CMS e2e, and lost when the dev server restarts.
 */
import { ToolError, type AgentCall, type AgentCallLog, type AgentUsage, type Scope, type ToolErrorCode } from '@signforge/tools';

/** One call as /mcp records it. Never its input, output or message. */
export interface CallRecord {
  orgId: string;
  grantId: string;
  clientId: string;
  /** A registry tool's name, `tools/list`, or `(unknown)`: never a name the agent made up. */
  tool: string;
  result: 'ok' | ToolErrorCode | 'error';
  change: boolean;
  needs: Scope | null;
  target: { kind: string; id: string } | null;
  ms: number;
}

/** What a name that is no tool is recorded as: an agent chose it, and it could hold anything. */
export const UNKNOWN_TOOL = '(unknown)';

/** The data point a call is written as (the layout above). */
export function pointOf(c: CallRecord): AnalyticsEngineDataPoint {
  return {
    indexes: [c.grantId],
    blobs: [c.orgId, c.grantId, c.clientId, c.tool, c.result, c.needs ?? '', c.target?.kind ?? '', c.target?.id ?? ''],
    doubles: [c.ms, c.change ? 1 : 0],
  };
}

/** Dev's calls, kept in this process: `wrangler dev` has no SQL API to read them back from. At most the last `DEV_KEPT`. */
const devCalls: (CallRecord & { at: number })[] = [];
const DEV_KEPT = 10_000;

/** Writes one call. A write is not awaited: the binding sends it after the response. */
export function recordCall(env: Pick<Env, 'AGENT_CALLS' | 'ENVIRONMENT'>, call: CallRecord, now: number) {
  env.AGENT_CALLS.writeDataPoint(pointOf(call));
  if (env.ENVIRONMENT === 'dev') {
    devCalls.push({ ...call, at: now });
    if (devCalls.length > DEV_KEPT) devCalls.splice(0, devCalls.length - DEV_KEPT);
  }
}

const callOf = (c: Omit<CallRecord, 'orgId' | 'grantId' | 'clientId' | 'ms'> & { at: number }): AgentCall => ({
  at: c.at,
  tool: c.tool,
  result: c.result,
  change: c.change,
  needs: c.needs,
  target: c.target,
});

/** What counts as a refusal: the agent asked for what it may not do, or too often. Not found, bad input and faults are calls, not refusals. */
const REFUSED = ['forbidden', 'rate_limited'];

/** The counts of `calls`, by grant. */
function tally(calls: { grantId: string; result: string; change: boolean; needs: string | null; n: number }[]): AgentUsage[] {
  const by = new Map<string, AgentUsage>();
  for (const c of calls) {
    const u = by.get(c.grantId) ?? { grantId: c.grantId, calls: 0, changes: 0, drafts: 0, refusals: 0 };
    u.calls += c.n;
    if (REFUSED.includes(c.result)) u.refusals += c.n;
    else if (c.result === 'ok' && c.change) {
      u.changes += c.n;
      if (c.needs === 'content:draft') u.drafts += c.n;
    }
    by.set(c.grantId, u);
  }
  return [...by.values()];
}

/** Dev's log, read from this process, one org's. */
function devLog(orgId: string): AgentCallLog {
  const of = (since: number) => devCalls.filter((c) => c.orgId === orgId && c.at >= since);
  return {
    usage: async (grantIds, since) =>
      tally(
        of(since)
          .filter((c) => grantIds.includes(c.grantId))
          .map((c) => ({ ...c, n: 1 })),
      ),
    recent: async (grantId, since, limit) =>
      of(since)
        .filter((c) => c.grantId === grantId)
        .toReversed()
        .slice(0, limit)
        .map(callOf),
    lastRefusal: async (grantId, since) => {
      const last = of(since).findLast((c) => c.grantId === grantId && REFUSED.includes(c.result));
      return last ? callOf(last) : null;
    },
  };
}

/** An id as an SQL literal: ours, never a caller's text, and refused if it is anything but an id. */
function literal(id: string): string {
  if (!/^[\w-]{1,100}$/.test(id)) throw new Error(`not an id: ${JSON.stringify(id)}`);
  return `'${id}'`;
}

/** The SQL of each read, one org's (exported for its test: the live API cannot be reached from tests). */
export const callSql = {
  usage: (dataset: string, orgId: string, grantIds: readonly string[], seconds: number) =>
    `SELECT blob2 AS grant, blob5 AS result, double2 AS change, blob6 AS needs, SUM(_sample_interval) AS n FROM ${dataset} ` +
    `WHERE blob1 = ${literal(orgId)} AND index1 IN (${grantIds.map(literal).join(', ')}) AND timestamp > NOW() - INTERVAL '${seconds}' SECOND ` +
    'GROUP BY grant, result, change, needs FORMAT JSON',
  recent: (dataset: string, orgId: string, grantId: string, seconds: number, limit: number, refusedOnly: boolean) =>
    `SELECT timestamp, blob4 AS tool, blob5 AS result, double2 AS change, blob6 AS needs, blob7 AS targetKind, blob8 AS targetId FROM ${dataset} ` +
    `WHERE blob1 = ${literal(orgId)} AND index1 = ${literal(grantId)} AND timestamp > NOW() - INTERVAL '${seconds}' SECOND` +
    `${refusedOnly ? ` AND blob5 IN (${REFUSED.map(literal).join(', ')})` : ''} ORDER BY timestamp DESC LIMIT ${Math.trunc(limit)} FORMAT JSON`,
};

interface Row {
  [column: string]: unknown;
}

/** The SQL API's `data` rows (FORMAT JSON). */
export function rowsOf(body: unknown): Row[] {
  const data = typeof body === 'object' && body !== null && 'data' in body ? body.data : undefined;
  if (!Array.isArray(data)) throw new Error('the call log answered without data');
  return data.filter((r): r is Row => typeof r === 'object' && r !== null);
}

const text = (v: unknown) => (typeof v === 'string' ? v : String(v ?? ''));
/** A row's call, as the SQL API writes it (its timestamp `YYYY-MM-DD hh:mm:ss`, in UTC). */
export function callOfRow(r: Row): AgentCall {
  const kind = text(r.targetKind);
  const needs = text(r.needs);
  return {
    at: Date.parse(`${text(r.timestamp).replace(' ', 'T')}Z`),
    tool: text(r.tool),
    result: text(r.result),
    change: Number(r.change) === 1,
    needs: needs || null,
    target: kind ? { kind, id: text(r.targetId) } : null,
  };
}

/** How long a page waits for the SQL API before saying the numbers are not available. */
const SQL_TIMEOUT_MS = 5_000;

/** The deployed log: Analytics Engine's SQL API, one org's. */
function sqlLog(
  env: { ANALYTICS_ACCOUNT_ID: string; ANALYTICS_TOKEN: string; AGENT_CALLS_DATASET: string },
  orgId: string,
  fetcher: typeof fetch,
): AgentCallLog {
  // Any failure, an answer that is no answer included, is the log being unavailable: the pages say so and show the rest.
  const query = async (sql: string): Promise<Row[]> => {
    try {
      const res = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${env.ANALYTICS_ACCOUNT_ID}/analytics_engine/sql`, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.ANALYTICS_TOKEN}` },
        body: sql,
        signal: AbortSignal.timeout(SQL_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`the SQL API answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return rowsOf(await res.json());
    } catch (err) {
      console.error('[agent calls] the call log could not be read', err);
      // biome-ignore lint/style/useErrorCause: the cause is passed, in the options argument.
      throw new ToolError('unavailable', 'the call log could not be read just now; try again in a minute', undefined, false, { cause: err });
    }
  };
  const seconds = (since: number) => Math.max(1, Math.round((Date.now() - since) / 1000));
  const dataset = env.AGENT_CALLS_DATASET;
  return {
    usage: async (grantIds, since) =>
      tally(
        (await query(callSql.usage(dataset, orgId, grantIds, seconds(since)))).map((r) => ({
          grantId: text(r.grant),
          result: text(r.result),
          change: Number(r.change) === 1,
          needs: text(r.needs) || null,
          n: Number(r.n),
        })),
      ),
    recent: async (grantId, since, limit) => (await query(callSql.recent(dataset, orgId, grantId, seconds(since), limit, false))).map(callOfRow),
    lastRefusal: async (grantId, since) => {
      const [row] = await query(callSql.recent(dataset, orgId, grantId, seconds(since), 1, true));
      return row ? callOfRow(row) : null;
    },
  };
}

/**
 * The org's call log, for the grant tools: the SQL API where it is configured, this process's own
 * in dev, none otherwise (a deployed environment without its token: the usage tool is refused, and
 * the pages say the numbers are not available).
 */
export function agentCallLog(env: Env, orgId: string, fetcher: typeof fetch = fetch): AgentCallLog | undefined {
  const { ANALYTICS_ACCOUNT_ID, ANALYTICS_TOKEN, AGENT_CALLS_DATASET } = env;
  if (ANALYTICS_ACCOUNT_ID && ANALYTICS_TOKEN) return sqlLog({ ANALYTICS_ACCOUNT_ID, ANALYTICS_TOKEN, AGENT_CALLS_DATASET }, orgId, fetcher);
  return env.ENVIRONMENT === 'dev' ? devLog(orgId) : undefined;
}
