/**
 * The dispatcher: the one door to every tool.
 *
 *   1. For an agent, count the call against its grant's limits (`AGENT_LIMITS`) and refuse it
 *      with `rate_limited` over one, before anything else runs. Then find the tool by name.
 *   2. Check the caller's role reaches the tool's minimum and its scopes include the tool's. An
 *      editor's scopes are read per call from the org's settings: with `editorsPublish` off, they
 *      lack `content:publish` (owner decision Q7).
 *   3. Validate the input with the tool's zod schema.
 *   4. Run the handler with `scoped(db, orgId)`, the actor and the parsed input. A handler reads
 *      freely but never writes: it stages each change with `ctx.write`.
 *   5. Commit the staged writes and their `audit_log` row (actor kind and id, client id, action,
 *      target, and the input with secrets redacted) in one D1 `batch()`, which is atomic: if the
 *      audit row cannot be written, the change is not made either. A call that staged nothing
 *      changed nothing and is not audited, nor is a read, unless the tool is `alwaysAudited`
 *      (a command to a screen). A refusal (`ToolError`) commits nothing,
 *      unless it says it `changed` something: then what was staged is committed, audited with
 *      the refusal. A call that does not succeed runs the undos its handler registered
 *      with `ctx.onDiscard`. Any other error commits nothing. An update given `ifVersion` whose row has
 *      changed since (checked when staged, and again inside the batch) is refused with
 *      `conflict` and `{ id, version }`, the version now.
 *
 * A platform tool (`platformRegistry`, run by `/admin` with `platform(db)`) is audited the same way
 * in `platform_audit_log`, since what it changes belongs to no org.
 */
import { NotInOrgError, StaleVersionError, type OrgScope, type Staged, type Write } from '@signforge/db';
import { canonicalJson } from '@signforge/contract';
import { z } from 'zod';
import { checkOutput } from './output';
import { orgSettings } from './settings';
import type { UploadSigner } from './upload';
import {
  AGENT_LIMITS,
  ROLE_SCOPES,
  ROLES,
  ToolError,
  type Actor,
  type AgentLimit,
  type AgentLimiter,
  type AnyTool,
  type DataScope,
  type Role,
  type Scope,
  type RateLimiter,
  type Connectors,
  type FeedUrlSealer,
  type AlertDeliverer,
  type AlertSecretSealer,
  type PlaceFinder,
  type TableReader,
  type ScreenNotifier,
  type TemplateChecker,
  type ToolErrorCode,
} from './tool';

/** Who is calling, resolved by the adapter (the `/api` route, `/admin`, later MCP and WebMCP). */
export interface Caller<D extends DataScope = OrgScope> {
  /** `scoped(db, orgId)` for the caller's active org: the only org it can reach. For the platform registry, `platform(db)`. */
  org: D;
  /** The caller's role in that org, read fresh by the adapter. */
  role: Role;
  /** The scopes its grant names. Omitted for a session: everything the role allows. Never more than the role allows either way. */
  scopes?: readonly Scope[];
  actor: Actor;
  blobs: R2Bucket;
  /** Signs direct uploads to `blobs`. Asset uploads need it; nothing else does. */
  uploads?: UploadSigner;
  /** Seals feed URLs. The data source tools that take a URL need it. */
  feedUrls?: FeedUrlSealer;
  /** Seals alert channels' URLs and secrets. The tools that set a channel need it. */
  alertSecrets?: AlertSecretSealer;
  /** Sends a test or a retry at once. Without it, they go at the next delivery run. */
  deliveries?: AlertDeliverer;
  /** Looks places up by name. `find_places` needs it. */
  places?: PlaceFinder;
  /** Reads a table at a URL. `read_table` needs it. */
  tables?: TableReader;
  /** The runtime check of uploaded templates. Registering an org template needs it. */
  templateCheck?: TemplateChecker;
  /** Providers' OAuth. The connection tools need it. */
  connectors?: Connectors;
  /** Reaches screens' sockets. Without it, screens learn of a change at their next sync. */
  screens?: ScreenNotifier;
  /** Counts attempts against the caller's rate limits. `claim_screen` refuses without one. */
  rateLimit?: RateLimiter;
  /** Counts an agent's calls against its grant's limits. Required when the actor is an agent: dispatch throws without it. */
  agentLimiter?: AgentLimiter;
}

export type DispatchResult = { ok: true; output: unknown } | { ok: false; error: ToolErrorCode; message: string; details?: unknown };

const rank = (r: Role) => ROLES.indexOf(r);

/** A caller's role and grant, and whether its org lets editors publish (`editorsPublish` in its settings). */
export type Grant = Pick<Caller, 'role' | 'scopes'> & { editorsPublish: boolean };

/** The scopes a caller actually holds: its grant's, capped by its role's as its org has it. */
export function effectiveScopes(grant: Grant): Scope[] {
  const editorOnly = grant.role === 'editor' && !grant.editorsPublish;
  const allowed = ROLE_SCOPES[grant.role].filter((s) => !(editorOnly && s === 'content:publish'));
  return grant.scopes ? grant.scopes.filter((s) => allowed.includes(s)) : [...allowed];
}

/** Whether the caller may use the tool at all. */
export function permits(grant: Grant, tool: AnyTool<any>): boolean {
  return rank(grant.role) >= rank(tool.minRole) && effectiveScopes(grant).includes(tool.scope);
}

/** The caller's grant, with the org's setting read now, so an owner's change applies from the next call. */
export async function grantOf(caller: Pick<Caller<DataScope>, 'org' | 'role' | 'scopes'>): Promise<Grant> {
  // Only an editor's scopes depend on it. The platform's data has no org settings, and its callers are owners.
  const editorsPublish = caller.role !== 'editor' || !('settings' in caller.org) || (await orgSettings(caller.org)).editorsPublish;
  return { role: caller.role, scopes: caller.scopes, editorsPublish };
}

const SECRET_KEY =
  /secret|token|password|passcode|otp|authorization|cookie|api_?key|private_?key|credential$|url_?encrypted|feed_?url|webhook_?url|pairing_?code|oauth_?state|^code$|^resource$/i;
const REDACTED = '[redacted]';

/**
 * A copy of `value` fit for the audit log: any field whose name looks like a secret (`secret`,
 * `token`, `password`, `apiKey`, `code`, ...) is replaced by `[redacted]`, at any depth. Ids such
 * as `credentialId` are kept. Long strings are cut to 500 characters.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return REDACTED;
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? REDACTED : redact(v, depth + 1)]));
  }
  return value;
}

const fail = (error: ToolErrorCode, message: string, details?: unknown): DispatchResult => ({
  ok: false,
  error,
  message,
  ...(details === undefined ? {} : { details }),
});

/** An update refused because its row moved on since the caller read it (`ifVersion`, ./fields.ts). */
const stale = (err: StaleVersionError) => fail('conflict', err.message, { id: err.id, version: err.version });

/** Run a tool for a caller. Refusals come back as `{ ok: false }`; anything unexpected throws. */
export async function dispatch<D extends DataScope>(
  registry: ReadonlyMap<string, AnyTool<D>>,
  name: string,
  rawInput: unknown,
  caller: Caller<D>,
): Promise<DispatchResult> {
  const tool = registry.get(name);
  // Before the name is checked: a call to no tool still counts, as a call.
  if (caller.actor.kind === 'agent') {
    const refused = await overLimit(name, tool?.mutates ?? false, caller);
    if (refused) return refused;
  }
  if (!tool) return fail('unknown_tool', `no tool named ${JSON.stringify(name)}`);
  const grant = await grantOf(caller);
  if (!permits(grant, tool)) {
    if (permits({ ...grant, editorsPublish: true }, tool)) return fail('forbidden', 'Only owners publish in this organization');
    return fail('forbidden', `${tool.name} needs the ${tool.scope} scope and at least the ${tool.minRole} role`);
  }

  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return fail(
      'invalid_input',
      z.prettifyError(parsed.error),
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }

  // A retry of a creation made with this key gets the first result, and writes nothing.
  const keyed = tool.idempotent ? idempotencyOf(caller.org, tool.name, parsed.data) : undefined;
  if (keyed) {
    const prior = await keyed.find();
    if (prior) return prior;
  }

  const writes: Write[] = [];
  const notices: ((screens: ScreenNotifier) => Promise<void>)[] = [];
  const notify = (send: (screens: ScreenNotifier) => Promise<void>) => {
    if (!tool.mutates) throw new Error(`${tool.name} is a read and cannot notify screens`);
    notices.push(send);
  };
  /**
   * After the commit: a screen that cannot be told now still learns at its next sync, so a failure
   * here is logged, never returned as the call's failure (the change is made).
   */
  const tell = async () => {
    const { screens } = caller;
    if (!screens || !(writes.length || tool.alwaysAudited)) return;
    await Promise.all(notices.map((send) => send(screens).catch((err: unknown) => console.warn(`[tools] ${tool.name}: could not tell the screen`, err))));
  };
  const soon: string[] = [];
  const deliverNow = (deliveryId: string) => {
    if (!tool.mutates) throw new Error(`${tool.name} is a read and cannot deliver`);
    soon.push(deliveryId);
  };
  const write = <T>(change: Staged<T>): T => {
    if (!tool.mutates) throw new Error(`${tool.name} is a read and cannot write`);
    writes.push(...change.writes);
    return change.row;
  };
  // The writes and their audit row, in one atomic batch. Nothing staged, nothing written.
  const commit = async (target: { kind: string; id: string } | undefined, detail: Record<string, unknown>) => {
    if (!writes.length && !tool.alwaysAudited) return;
    const audit = caller.org.auditLog.stage({
      actorKind: caller.actor.kind,
      actorId: caller.actor.id,
      clientId: caller.actor.clientId ?? null,
      action: tool.name,
      targetKind: target?.kind ?? null,
      targetId: target?.id ?? null,
      detailJson: JSON.stringify({ input: redact(parsed.data), ...detail }),
    });
    await caller.org.commit([...writes, ...audit.writes]);
  };

  /** What the handler asked to undo if the call does not succeed (`onDiscard`). Best effort: a failure is logged. */
  const discards: (() => Promise<void>)[] = [];
  const onDiscard = (undo: () => Promise<void>) => {
    discards.push(undo);
  };
  /** A commit that failed: a refusal, if a guard or the tool says what refused it. */
  const refusedCommit = async (err: unknown): Promise<DispatchResult | undefined> => {
    // An `ifVersion` guard: the row changed between the handler's read and the commit.
    if (err instanceof StaleVersionError) return stale(err);
    if (err instanceof NotInOrgError) return fail('not_found', err.message);
    const refusal = await tool.refuseFailedCommit?.({ org: caller.org, input: parsed.data });
    return refusal && fail(refusal.code, refusal.message, refusal.details);
  };

  const run = async (): Promise<DispatchResult> => {
    let output: unknown;
    try {
      output = await tool.handler({
        org: caller.org,
        actor: caller.actor,
        role: caller.role,
        input: parsed.data,
        blobs: caller.blobs,
        uploads: caller.uploads,
        feedUrls: caller.feedUrls,
        alertSecrets: caller.alertSecrets,
        places: caller.places,
        tables: caller.tables,
        templateCheck: caller.templateCheck,
        connectors: caller.connectors,
        write,
        notify,
        deliverNow,
        onDiscard,
        rateLimit: caller.rateLimit,
      });
    } catch (err) {
      if (err instanceof ToolError) {
        // A refusal that changed something is recorded too, with what was refused.
        if (err.changed) {
          try {
            await commit(tool.target?.(parsed.data, undefined as never), { refused: { error: err.code, message: err.message } });
          } catch (commitErr) {
            // What it staged was refused too (another call changed it first): say so, as for a change.
            const refusal = await refusedCommit(commitErr);
            if (refusal) return refusal;
            throw commitErr;
          }
          await tell();
        }
        return fail(err.code, err.message, err.details);
      }
      if (err instanceof NotInOrgError) return fail('not_found', err.message);
      if (err instanceof StaleVersionError) return stale(err);
      throw err;
    }

    checkOutput(tool, output);
    if (keyed && writes.length) writes.push(...(await keyed.record(output)));
    try {
      await commit(tool.target?.(parsed.data, output), {});
    } catch (err) {
      // A concurrent call with the same key committed first, and this batch failed on its record.
      const prior = await keyed?.find();
      if (prior) return prior;
      const refusal = await refusedCommit(err);
      if (refusal) return refusal;
      throw err;
    }
    await tell();
    if (writes.length) for (const id of soon) caller.deliveries?.now(id);
    return { ok: true, output };
  };

  let succeeded = false;
  try {
    const result = await run();
    succeeded = result.ok;
    return result;
  } finally {
    // A call that did not succeed takes back what its handler did outside the batch.
    if (!succeeded) await Promise.all(discards.map((undo) => undo().catch((err: unknown) => console.warn(`[tools] ${tool.name}: could not undo`, err))));
  }
}

const OVER: Record<AgentLimit, string> = {
  calls_per_minute: `made ${AGENT_LIMITS.calls_per_minute} calls this minute`,
  writes_per_minute: `made ${AGENT_LIMITS.writes_per_minute} changes this minute`,
  writes_per_day: `made ${AGENT_LIMITS.writes_per_day} changes today (UTC)`,
};

/**
 * An agent's call counted against its grant's limits, before anything else is read or run. A
 * refused call writes nothing, except the audit row of the first one refused in each window.
 */
async function overLimit(name: string, write: boolean, caller: Caller<DataScope>): Promise<DispatchResult | undefined> {
  if (!caller.agentLimiter) throw new Error(`an agent called ${JSON.stringify(name)} without a limiter for its grant`);
  const allowance = await caller.agentLimiter.take(caller.actor.id, write);
  if (allowance.ok) return undefined;
  const { limit, retryAfterSeconds } = allowance;
  const message = `this agent grant ${OVER[limit]}, its limit; try again in ${retryAfterSeconds} s`;
  const details = { limit, retryAfterSeconds };
  const { agentLimiter, actor, org } = caller;
  if (allowance.audit) {
    if (!('appendOnce' in org.auditLog)) throw new Error('an agent acts only in an org');
    const { window, start } = allowance.audit;
    try {
      // One row per grant and window, however many refused calls race to write it.
      await org.auditLog.appendOnce(`rate_limited_${actor.id}_${window}_${start}`, {
        actorKind: 'agent',
        actorId: actor.id,
        clientId: actor.clientId ?? null,
        action: 'rate_limited',
        targetKind: null,
        targetId: null,
        // The name as the agent sent it, which may name no tool.
        detailJson: JSON.stringify({ tool: redact(name), refused: { error: 'rate_limited', message, details } }),
      });
      await agentLimiter.audited(actor.id, allowance.audit);
    } catch (err) {
      // Still a refusal, not an error: the window keeps asking for its row, and its next refused call writes it.
      console.warn(`[tools] could not record that agent grant ${actor.id} was refused`, err);
    }
  }
  return fail('rate_limited', message, details);
}

/**
 * The idempotency record of a keyed call: `find` returns the first call's result if this key was
 * used for the same tool and input (a conflict if not), `record` stages this call's.
 */
function idempotencyOf(org: DataScope, action: string, input: unknown) {
  const { idempotencyKey: key, ...rest } = input as { idempotencyKey?: string };
  if (key === undefined) return undefined;
  if (!('idempotency' in org)) throw new Error(`${action} takes an idempotency key, which only an org's scope records`);
  const inputSha256 = sha256Hex(canonicalJson(rest));
  return {
    find: async (): Promise<DispatchResult | undefined> => {
      const prior = await org.idempotency.get(key);
      if (!prior) return undefined;
      if (prior.action !== action || prior.inputSha256 !== (await inputSha256)) {
        return fail('conflict', `idempotency key ${JSON.stringify(key)} was used for a different call; use a new key for a new creation`);
      }
      return { ok: true, output: JSON.parse(prior.outputJson) };
    },
    record: async (output: unknown) => org.idempotency.stage({ key, action, inputSha256: await inputSha256, outputJson: JSON.stringify(output) }).writes,
  };
}

export async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** What a caller may use, for `GET /api/tools` and the MCP `tools/list`: name, description, scope, role, and JSON Schema input and output. */
export function describeTools(registry: ReadonlyMap<string, AnyTool<any>>, grant: Grant) {
  return [...registry.values()]
    .filter((t) => permits(grant, t))
    .map((t) => ({
      name: t.name,
      description: t.description,
      scope: t.scope,
      minRole: t.minRole,
      mutates: t.mutates,
      inputSchema: z.toJSONSchema(t.input, { io: 'input', unrepresentable: 'any' }),
      outputSchema: z.toJSONSchema(t.output, { io: 'output', unrepresentable: 'any' }),
      example: t.example,
    }));
}
