/**
 * The dispatcher: the one door to every tool.
 *
 *   1. Find the tool by name.
 *   2. Check the caller's role reaches the tool's minimum and its scopes include the tool's.
 *   3. Validate the input with the tool's zod schema.
 *   4. Run the handler with `scoped(db, orgId)`, the actor and the parsed input. A handler reads
 *      freely but never writes: it stages each change with `ctx.write`.
 *   5. Commit the staged writes and their `audit_log` row (actor kind and id, client id, action,
 *      target, and the input with secrets redacted) in one D1 `batch()`, which is atomic: if the
 *      audit row cannot be written, the change is not made either. A call that staged nothing
 *      changed nothing and is not audited, nor is a read. A refusal (`ToolError`) commits nothing,
 *      unless it says it `changed` something: then what was staged is committed, audited with
 *      the refusal. Any other error commits nothing.
 *
 * A platform tool (`platformRegistry`, run by `/admin` with `platform(db)`) is audited the same way
 * in `platform_audit_log`, since what it changes belongs to no org.
 */
import { NotInOrgError, type OrgScope, type Staged, type Write } from '@signforge/db';
import { canonicalJson } from '@signforge/contract';
import { z } from 'zod';
import { checkOutput } from './output';
import type { UploadSigner } from './upload';
import {
  ROLE_SCOPES,
  ROLES,
  ToolError,
  type Actor,
  type AnyTool,
  type DataScope,
  type Role,
  type Scope,
  type ScreenNotifier,
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
  /** Reaches screens' sockets. Without it, screens learn of a change at their next sync. */
  screens?: ScreenNotifier;
}

export type DispatchResult = { ok: true; output: unknown } | { ok: false; error: ToolErrorCode; message: string; details?: unknown };

const rank = (r: Role) => ROLES.indexOf(r);

/** The scopes a caller actually holds: its grant's, capped by its role's. */
export function effectiveScopes(caller: Pick<Caller, 'role' | 'scopes'>): Scope[] {
  const allowed = ROLE_SCOPES[caller.role] ?? [];
  return caller.scopes ? caller.scopes.filter((s) => allowed.includes(s)) : [...allowed];
}

/** Whether the caller may use the tool at all. */
export function permits(caller: Pick<Caller, 'role' | 'scopes'>, tool: AnyTool<any>): boolean {
  return rank(caller.role) >= rank(tool.minRole) && effectiveScopes(caller).includes(tool.scope);
}

const SECRET_KEY = /secret|token|password|passcode|otp|authorization|cookie|api_?key|private_?key|credential$|url_?encrypted|pairing_?code|^code$/i;
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

/** Run a tool for a caller. Refusals come back as `{ ok: false }`; anything unexpected throws. */
export async function dispatch<D extends DataScope>(
  registry: ReadonlyMap<string, AnyTool<D>>,
  name: string,
  rawInput: unknown,
  caller: Caller<D>,
): Promise<DispatchResult> {
  const tool = registry.get(name);
  if (!tool) return fail('unknown_tool', `no tool named ${JSON.stringify(name)}`);
  if (!permits(caller, tool)) {
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
    if (!screens || !writes.length) return;
    await Promise.all(notices.map((send) => send(screens).catch((err: unknown) => console.warn(`[tools] ${tool.name}: could not tell the screen`, err))));
  };
  const write = <T>(change: Staged<T>): T => {
    if (!tool.mutates) throw new Error(`${tool.name} is a read and cannot write`);
    writes.push(...change.writes);
    return change.row;
  };
  // The writes and their audit row, in one atomic batch. Nothing staged, nothing written.
  const commit = async (target: { kind: string; id: string } | undefined, detail: Record<string, unknown>) => {
    if (!writes.length) return;
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

  let output: unknown;
  try {
    output = await tool.handler({ org: caller.org, actor: caller.actor, input: parsed.data, blobs: caller.blobs, uploads: caller.uploads, write, notify });
  } catch (err) {
    if (err instanceof ToolError) {
      // A refusal that changed something is recorded too, with what was refused.
      if (err.changed) {
        await commit(tool.target?.(parsed.data, undefined as never), { refused: { error: err.code, message: err.message } });
        await tell();
      }
      return fail(err.code, err.message, err.details);
    }
    if (err instanceof NotInOrgError) return fail('not_found', err.message);
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
    throw err;
  }
  await tell();
  return { ok: true, output };
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

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** What a caller may use, for `GET /api/tools` and the MCP `tools/list`: name, description, scope, role, and JSON Schema input and output. */
export function describeTools(registry: ReadonlyMap<string, AnyTool<any>>, caller: Pick<Caller, 'role' | 'scopes'>) {
  return [...registry.values()]
    .filter((t) => permits(caller, t))
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
