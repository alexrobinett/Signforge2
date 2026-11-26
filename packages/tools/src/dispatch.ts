/**
 * The dispatcher: the one door to every tool.
 *
 *   1. For an agent, count the call against its grant's limits (`AGENT_LIMITS`) and refuse it
 *      with `rate_limited` over one, before anything else runs. Then find the tool by name.
 *   2. Check the caller's role reaches the tool's minimum and its scopes include the tool's. An
 *      editor's scopes are read per call from the org's settings: with `editorsPublish` off, they
 *      lack `content:publish` (owner decision Q7).
 *   3. Validate the input with the tool's zod schema.
 *      A call whose caller lacks a service the tool `needs` (`ToolServices`) is refused with
 *      `forbidden` before its handler runs, the same for every tool.
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
 *   6. A tool that `publishes` runs one call at a time per org (`Caller.publishLock`), and a call
 *      whose commit lost to another publish, an edit or a deleted screen (`StaleVersionError`)
 *      runs again from a fresh read, up to `PUBLISH_ATTEMPTS` times in all.
 *
 * A platform tool (`platformRegistry`, run by `/admin` with `platform(db)`) is audited the same way
 * in `platform_audit_log`, since what it changes belongs to no org.
 */
import { NotInOrgError, StaleVersionError, type OrgScope, type Staged, type Write } from '@signforge/db';
import { canonicalJson, ID_PATTERN } from '@signforge/contract';
import { z } from 'zod';
import { checkOutput } from './output';
import { orgSettings } from './settings';
import {
  AGENT_LIMITS,
  ROLE_SCOPES,
  ROLES,
  isAgent,
  SERVICE_WORDS,
  ToolError,
  type Actor,
  type AgentLimit,
  type AgentLimiter,
  type AnyTool,
  type DataScope,
  type Role,
  type Scope,
  type ScreenNotifier,
  type ServiceName,
  type ToolServices,
} from './tool';
import type { ToolErrorCode } from './outputs';

/** Who is calling, resolved by the adapter (the `/api` route, `/admin`, `/mcp`, later WebMCP). */
export interface Caller<D extends DataScope = OrgScope> {
  /** `scoped(db, orgId)` for the caller's active org: the only org it can reach. For the platform registry, `platform(db)`. */
  org: D;
  /** The caller's role in that org, read fresh by the adapter. */
  role: Role;
  /** The scopes its grant names. Omitted for a session: everything the role allows. Never more than the role allows either way. */
  scopes?: readonly Scope[];
  actor: Actor;
  blobs: R2Bucket;
  /**
   * What its tools may use (`ToolServices`). Each adapter builds them with its environment's one
   * constructor: the API's (apps/api/src/tool-services.ts) for `/api`, `/admin` and `/mcp`; a test's
   * fakes (test/services.ts).
   */
  services: ToolServices;
  /**
   * Runs `run` while no other publish of the org runs (the API: the org's Durable Object). Without
   * it, publishes may overlap, and the publish revision's guard still commits them in order.
   */
  publishLock?: <T>(run: () => Promise<T>) => Promise<T>;
  /** Counts an agent's calls against its grant's limits. Required when the actor is an agent: dispatch throws without it. */
  agentLimiter?: AgentLimiter;
  /**
   * The user whose membership `role` is: the session's, or an agent's grant's (the API sets it). A
   * publish reads that role again under the org's lock, on every attempt, and its batch holds the
   * role and the org's `editorsPublish` to the commit, so a member demoted meanwhile publishes nothing.
   */
  member?: string;
  /**
   * The confirmation card the person pressed for this call (#269, the CMS agent's drawer): its summary,
   * and the agent run and call it resumed, on the audit row, which a confirmed read gets too.
   */
  confirmed?: { summary: string; runId: string; callId: string };
}

export type DispatchResult = { ok: true; output: unknown } | { ok: false; error: ToolErrorCode; message: string; details?: unknown };

const rank = (r: Role) => ROLES.indexOf(r);
const isRole = (r: unknown): r is Role => ROLES.some((x) => x === r);

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

/** How many times a publish is run before a lost race is returned as `conflict`. */
const PUBLISH_ATTEMPTS = 3;

/** An update refused because its row moved on since the caller read it (`ifVersion`, ./fields.ts). */
const stale = (err: StaleVersionError) => fail('conflict', err.message, { id: err.id, version: err.version });

/** Run a tool for a caller. Refusals come back as `{ ok: false }`; anything unexpected throws. */
export async function dispatch<D extends DataScope>(
  registry: ReadonlyMap<string, AnyTool<D>>,
  name: string,
  rawInput: unknown,
  caller: Caller<D>,
): Promise<DispatchResult> {
  const audited = { row: false };
  const result = await dispatchCall(registry, name, rawInput, caller, audited);
  // A person's press of a card (#269) is recorded however it is refused: by role, scope, a check, a lost race.
  return caller.confirmed && !result.ok && !audited.row ? refusedPress(registry, name, rawInput, caller, result) : result;
}

/**
 * A person's press of a confirmation card (`Caller.confirmed`), refused: its audit row alone, with the
 * input it would have run and why not. Nothing the call staged is written, and no screen is told.
 * The row's target is named from the input only, as a refused call has no output.
 */
export async function refusedPress<D extends DataScope>(
  registry: ReadonlyMap<string, AnyTool<D>>,
  name: string,
  rawInput: unknown,
  caller: Caller<D>,
  refusal: Extract<DispatchResult, { ok: false }>,
): Promise<DispatchResult> {
  const tool = registry.get(name);
  const parsed = tool?.input.safeParse(rawInput ?? {});
  const target = tool?.target && parsed?.success ? tool.target(parsed.data, undefined as never) : undefined;
  const audit = caller.org.auditLog.stage({
    actorKind: caller.actor.kind,
    actorId: caller.actor.id,
    clientId: caller.actor.clientId ?? null,
    action: name,
    targetKind: target?.kind ?? null,
    targetId: target?.id ?? null,
    detailJson: JSON.stringify({
      input: redact(parsed?.success ? parsed.data : rawInput),
      refused: { error: refusal.error, message: refusal.message },
      confirmed: caller.confirmed,
    }),
  });
  await caller.org.commit(audit.writes);
  return refusal;
}

async function dispatchCall<D extends DataScope>(
  registry: ReadonlyMap<string, AnyTool<D>>,
  name: string,
  rawInput: unknown,
  caller: Caller<D>,
  audited: { row: boolean },
): Promise<DispatchResult> {
  const tool = registry.get(name);
  // Before the name is checked: a call to no tool still counts, as a call.
  if (caller.actor.kind === 'agent') {
    const refused = await overLimit(name, tool?.mutates ?? false, caller);
    if (refused) return refused;
  }
  if (!tool) return fail('unknown_tool', `no tool named ${JSON.stringify(name)}`);
  if (tool.people && isAgent(caller.actor)) return fail('forbidden', `${tool.name} is for people only: a person does it in the CMS`);
  const grant = await grantOf(caller);
  /** Refused unless `g` permits the tool. Asked again under a publish's lock, for each attempt, as the setting may have changed meanwhile. */
  const refusedBy = (g: Grant): DispatchResult | undefined => {
    if (permits(g, tool)) return undefined;
    if (permits({ ...g, editorsPublish: true }, tool)) return fail('forbidden', 'Only owners publish in this organization');
    return fail('forbidden', `${tool.name} needs the ${tool.scope} scope and at least the ${tool.minRole} role`);
  };
  const refused = refusedBy(grant);
  if (refused) return refused;
  // The role a change was checked for, held to the commit, checked by the batch as it runs: the right to publish (the
  // member still in a role that may, and an editor only while editors publish; without a member to read, the setting
  // alone), and an owner's (review of #414: one demoted between the read and the batch is refused), for whatever the
  // batch commits, an audit row alone included (#417). An owner's change made through Better Auth stages nothing and
  // commits nothing here, and Better Auth checks the role as it makes it.
  // A tool of a lesser scope whose call reaches screens all the same asks for the right to publish (`ctx.publishRight`):
  // checked as it asks, and held to the commit as a publish's is (#122).
  let holdsPublish = false;
  const roleRight = (): Write[] => {
    if (!tool.mutates || !('settings' in caller.org)) return [];
    const publishing = tool.scope === 'content:publish' || holdsPublish;
    if (!publishing && tool.minRole !== 'owner') return [];
    const least = publishing && rank(tool.minRole) < rank('editor') ? 'editor' : tool.minRole;
    if (caller.member) return caller.org.members.stage.stillMay(caller.member, ROLES.slice(rank(least)), publishing).writes;
    return publishing && caller.role === 'editor' ? caller.org.settings.stage.editorsPublish().writes : [];
  };
  /** The right the role guard held, lost by the commit: why, as the role and setting are now. */
  const lostRight = async (): Promise<DispatchResult> => {
    const role = caller.member && 'members' in caller.org ? await caller.org.members.roleOf(caller.member) : caller.role;
    if (!isRole(role)) return fail('forbidden', 'you are no longer a member of this organization');
    const now = await grantOf({ ...caller, role });
    const refusal = refusedBy(now);
    if (refusal) return refusal;
    if (holdsPublish && !effectiveScopes(now).includes('content:publish'))
      return fail(
        'forbidden',
        now.role === 'editor' && !now.editorsPublish ? 'Only owners publish in this organization' : `${tool.name} needs the right to publish here`,
      );
    // Back by the time it is read: it changed and changed back meanwhile.
    return fail('forbidden', `your right to ${tool.name} changed while it ran: read again and retry`);
  };

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

  const { services } = caller;
  if (!provides(services, tool.needs ?? [])) {
    const lacking = (tool.needs ?? []).filter((n) => services[n] === undefined).map((n) => SERVICE_WORDS[n]);
    return fail('forbidden', `${tool.name} needs ${lacking.join(' and ')}, and this caller has none`);
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
    const { notify: screens } = services;
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
    if (!writes.length && !tool.alwaysAudited && !caller.confirmed) return;
    const audit = caller.org.auditLog.stage({
      actorKind: caller.actor.kind,
      actorId: caller.actor.id,
      clientId: caller.actor.clientId ?? null,
      action: tool.name,
      targetKind: target?.kind ?? null,
      targetId: target?.id ?? null,
      detailJson: JSON.stringify({ input: redact(parsed.data), ...detail, ...(caller.confirmed !== undefined && { confirmed: caller.confirmed }) }),
    });
    await caller.org.commit([...roleRight(), ...writes, ...audit.writes]);
    audited.row = true;
  };

  /** What the handler asked to undo if the call does not succeed (`onDiscard`). Best effort: a failure is logged. */
  const discards: (() => Promise<void>)[] = [];
  const onDiscard = (undo: () => Promise<void>) => {
    discards.push(undo);
  };
  /** A commit that failed: a refusal, the tool's own words for it first, then a guard's. */
  const refusedCommit = async (err: unknown): Promise<DispatchResult | undefined> => {
    const refusal = await tool.refuseFailedCommit?.({ org: caller.org, input: parsed.data, actor: caller.actor });
    // A role guard (`stillMay`, first in its batch): the member lost the right between the read and the batch, whatever
    // else changed meanwhile (#417). Said in the tool's own words when it has them, else as the role and setting are now.
    if (err instanceof StaleVersionError && err.id === 'member') {
      if (refusal?.code === 'forbidden') return fail(refusal.code, refusal.message, refusal.details);
      return lostRight();
    }
    if (refusal) return fail(refusal.code, refusal.message, refusal.details);
    // An `ifVersion` guard: the row changed between the handler's read and the commit.
    if (err instanceof StaleVersionError) return stale(err);
    if (err instanceof NotInOrgError) return fail('not_found', err.message);
    return undefined;
  };

  const publishRight = (why: string) => {
    if (!tool.mutates) throw new Error(`${tool.name} is a read and cannot ask for the right to publish`);
    if (!effectiveScopes(grant).includes('content:publish')) throw new ToolError('forbidden', why);
    holdsPublish = true;
  };

  const runRead = async (name: string, input: unknown): Promise<unknown> => {
    const other = registry.get(name);
    if (!other || other.mutates || other.people || tool.mutates) throw new Error(`${tool.name} cannot run ${name}`);
    if (!permits(grant, other)) throw new ToolError('forbidden', `${name} needs the ${other.scope} scope and at least the ${other.minRole} role`);
    const args = other.input.safeParse(input ?? {});
    if (!args.success)
      throw new ToolError(
        'invalid_input',
        z.prettifyError(args.error),
        args.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    if (!provides(services, other.needs ?? [])) {
      const lacking = (other.needs ?? []).filter((n) => services[n] === undefined).map((n) => SERVICE_WORDS[n]);
      throw new ToolError('forbidden', `${name} needs ${lacking.join(' and ')}, and this caller has none`);
    }
    const output = await other.handler({
      org: caller.org,
      actor: caller.actor,
      role: caller.role,
      scopes: effectiveScopes(grant),
      confirmed: caller.confirmed !== undefined,
      input: args.data,
      blobs: caller.blobs,
      services,
      write,
      notify,
      deliverNow,
      onDiscard,
      publishRight,
      run: runRead,
    });
    checkOutput(other, output);
    return output;
  };

  const run = async (): Promise<DispatchResult> => {
    let output: unknown;
    holdsPublish = false;
    try {
      output = await tool.handler({
        org: caller.org,
        actor: caller.actor,
        role: caller.role,
        scopes: effectiveScopes(grant),
        confirmed: caller.confirmed !== undefined,
        input: parsed.data,
        blobs: caller.blobs,
        services,
        write,
        notify,
        deliverNow,
        onDiscard,
        publishRight,
        run: runRead,
      });
    } catch (err) {
      if (err instanceof ToolError) {
        // A refusal that changed something is recorded too, with what was refused. One that changed nothing writes nothing it
        // staged: a person's press of a card (#269) refused so gets its row alone (`refusedPress`).
        if (err.changed) {
          try {
            await commit(tool.target?.(parsed.data, undefined as never), {
              refused: { error: err.code, message: err.message },
              ...(err.auditDetail ? { detail: redact(err.auditDetail) } : {}),
            });
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
      // Under its own key, redacted: it cannot stand for the input or a refusal, nor carry a secret.
      const more = tool.auditDetail?.(output);
      await commit(tool.target?.(parsed.data, output), more ? { detail: redact(more) } : {});
    } catch (err) {
      // A publish that lost a race runs again (`publishAttempts`).
      if (tool.publishes && err instanceof StaleVersionError) throw err;
      // A concurrent call with the same key committed first, and this batch failed on its record.
      const prior = await keyed?.find();
      if (prior) return prior;
      const refusal = await refusedCommit(err);
      if (refusal) return refusal;
      throw err;
    }
    await tell();
    if (writes.length) for (const id of soon) services.deliverNow?.(id);
    return { ok: true, output };
  };

  /** A publish: again from a fresh read while it loses races, then the last loss as a conflict. */
  const publishAttempts = async (): Promise<DispatchResult> => {
    for (let attempt = 1; ; attempt++) {
      writes.length = 0;
      notices.length = 0;
      // Under the lock and on every attempt: a role or a setting changed while it waited or lost a race takes effect.
      const role = caller.member && 'members' in caller.org ? await caller.org.members.roleOf(caller.member) : caller.role;
      if (!isRole(role)) return fail('forbidden', 'you are no longer a member of this organization');
      const now = refusedBy(await grantOf({ ...caller, role }));
      if (now) return now;
      try {
        return await run();
      } catch (err) {
        if (!(err instanceof StaleVersionError)) throw err;
        // The role guard, on any attempt: the right is gone, not a race to run again (#419).
        if (err.id === 'member') return lostRight();
        if (attempt === PUBLISH_ATTEMPTS) return stale(err);
      }
    }
  };

  let succeeded = false;
  try {
    const result = !tool.publishes ? await run() : caller.publishLock ? await caller.publishLock(publishAttempts) : await publishAttempts();
    succeeded = result.ok;
    return result;
  } finally {
    // A call that did not succeed takes back what its handler did outside the batch.
    if (!succeeded) await Promise.all(discards.map((undo) => undo().catch((err: unknown) => console.warn(`[tools] ${tool.name}: could not undo`, err))));
  }
}

/** Whether the caller's services include every one the tool needs. */
const provides = <N extends ServiceName>(services: ToolServices, needs: readonly N[]): services is ToolServices & Pick<Required<ToolServices>, N> =>
  needs.every((n) => services[n] !== undefined);

const OVER: Record<AgentLimit, string> = {
  calls_per_minute: `made ${AGENT_LIMITS.calls_per_minute} calls this minute`,
  writes_per_minute: `made ${AGENT_LIMITS.writes_per_minute} changes this minute`,
  writes_per_day: `made ${AGENT_LIMITS.writes_per_day} changes today (UTC)`,
};

/**
 * An agent's call counted against its grant's limits, before anything else is read or run. A
 * refused call writes nothing, except the audit row of the first one refused in each window.
 * `dispatch` counts every tool call through it; `/mcp` counts its `tools/list` too (M4-06).
 */
export async function overLimit(name: string, write: boolean, caller: Caller<DataScope>): Promise<DispatchResult | undefined> {
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
    // Still a refusal, not an error, if either step fails: the window keeps asking for its row, and its next refused call writes it.
    let recorded = false;
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
      recorded = true;
      await agentLimiter.audited(actor.id, allowance.audit);
    } catch (err) {
      console.warn(
        recorded
          ? `[tools] recorded that agent grant ${actor.id} was refused, but could not tell its limiter: the window's next refusal tries again and writes nothing`
          : `[tools] could not record that agent grant ${actor.id} was refused`,
        err,
      );
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

/**
 * A tool's input as an agent is shown it (#345). As JSON (`tools/list`, `GET /api/tools`, what a model is sent) it is
 * the zod input's JSON Schema with only what helps write a call: no `$schema` line, id pattern or safe-integer bounds.
 * As a Standard Schema (`~standard`, which JSON leaves out) it is the whole zod input, so TanStack AI checks a drawer's
 * call against it before the tool runs or pauses for a card, and tells the model what was wrong. The dispatcher checks
 * it again.
 */
export class ListedInput {
  [field: string]: unknown;
  readonly #input: z.ZodType;
  readonly #schema: Record<string, unknown>;

  constructor(input: z.ZodType) {
    const { $schema: _dropped, ...schema } = z.toJSONSchema(input, {
      io: 'input',
      unrepresentable: 'any',
      override: ({ jsonSchema: s }) => {
        if (s.pattern === ID_PATTERN.source) delete s.pattern;
        if (s.maximum === Number.MAX_SAFE_INTEGER) delete s.maximum;
        if (s.minimum === Number.MIN_SAFE_INTEGER) delete s.minimum;
      },
    });
    Object.assign(this, schema);
    this.#input = input;
    this.#schema = schema;
  }

  get '~standard'(): z.ZodType['~standard'] {
    const listed = () => structuredClone(this.#schema);
    return { ...this.#input['~standard'], jsonSchema: { input: listed, output: listed } };
  }
}

/**
 * What a caller may use, for `GET /api/tools` and the MCP `tools/list`: name, description, scope, role, and JSON Schema
 * input and output. With `services`, a tool that lists by them (`read`'s types) leaves out what they cannot serve.
 */
export function describeTools(registry: ReadonlyMap<string, AnyTool<any>>, grant: Grant, services?: ToolServices) {
  return [...registry.values()]
    .filter((t) => permits(grant, t))
    .map((t) => ({
      name: t.name,
      description: t.listedDescription?.(grant, services) ?? t.description,
      scope: t.scope,
      minRole: t.minRole,
      mutates: t.mutates,
      inputSchema: new ListedInput(t.listedInput?.(grant, services) ?? t.input),
      outputSchema: z.toJSONSchema(t.output, { io: 'output', unrepresentable: 'any' }),
      example: t.example,
    }));
}
