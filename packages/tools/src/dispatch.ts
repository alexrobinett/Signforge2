/**
 * The dispatcher: the one door to every tool.
 *
 *   1. Find the tool by name.
 *   2. Check the caller's role reaches the tool's minimum and its scopes include the tool's.
 *   3. Validate the input with the tool's zod schema.
 *   4. Run the handler with `scoped(db, orgId)`, the actor and the parsed input.
 *   5. If the tool changes data, append to `audit_log`: actor kind and id, client id, action,
 *      target, and the input with secrets redacted. Reads are not audited, nor are refusals,
 *      except one whose `ToolError` says it changed something on the way.
 *
 * A platform tool (`platformRegistry`, run by `/admin` with `platform(db)`) is audited the same way
 * in `platform_audit_log`, since what it changes belongs to no org.
 *
 * D1 has no interactive transactions, so the audit row is written after the change succeeds.
 * Should that write fail, the error propagates (a 500) and the change stands unrecorded; it is
 * not retried silently.
 */
import { NotInOrgError, type OrgScope } from '@signforge/db';
import { z } from 'zod';
import type { UploadSigner } from './upload';
import { ROLE_SCOPES, ROLES, ToolError, type Actor, type AnyTool, type DataScope, type Role, type Scope, type ToolErrorCode } from './tool';

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
}

export type DispatchResult =
  | { ok: true; output: unknown }
  | { ok: false; error: ToolErrorCode; message: string; details?: unknown };

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

const fail = (error: ToolErrorCode, message: string, details?: unknown): DispatchResult => ({ ok: false, error, message, ...(details === undefined ? {} : { details }) });

/** Run a tool for a caller. Refusals come back as `{ ok: false }`; anything unexpected throws. */
export async function dispatch<D extends DataScope>(registry: ReadonlyMap<string, AnyTool<D>>, name: string, rawInput: unknown, caller: Caller<D>): Promise<DispatchResult> {
  const tool = registry.get(name);
  if (!tool) return fail('unknown_tool', `no tool named ${JSON.stringify(name)}`);
  if (!permits(caller, tool)) {
    return fail('forbidden', `${tool.name} needs the ${tool.scope} scope and at least the ${tool.minRole} role`);
  }

  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return fail('invalid_input', z.prettifyError(parsed.error), parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }

  const audit = (target: { kind: string; id: string } | undefined, detail: Record<string, unknown>) =>
    caller.org.auditLog.append({
      actorKind: caller.actor.kind,
      actorId: caller.actor.id,
      clientId: caller.actor.clientId ?? null,
      action: tool.name,
      targetKind: target?.kind ?? null,
      targetId: target?.id ?? null,
      detailJson: JSON.stringify({ input: redact(parsed.data), ...detail }),
    });

  let output: unknown;
  try {
    output = await tool.handler({ org: caller.org, actor: caller.actor, input: parsed.data, blobs: caller.blobs, uploads: caller.uploads });
  } catch (err) {
    if (err instanceof ToolError) {
      // A refusal that changed something is recorded too, with what was refused.
      if (tool.mutates && err.changed) await audit(tool.target?.(parsed.data, undefined as never), { refused: { error: err.code, message: err.message } });
      return fail(err.code, err.message, err.details);
    }
    if (err instanceof NotInOrgError) return fail('not_found', err.message);
    throw err;
  }

  if (tool.mutates) await audit(tool.target?.(parsed.data, output), {});
  return { ok: true, output };
}

/** What a caller may use, for `GET /api/tools` and the MCP `tools/list`: name, description, scope, role and JSON Schema input. */
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
      example: t.example,
    }));
}
