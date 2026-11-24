// Calling tools in a test as the CMS does: as an editor of the org, through the registry.
import type { OrgScope, Write } from '@signforge/db';
import { type AgentLimiter, type Caller, dispatch, registry } from '../src';
import { memberOf } from './member';

/** A function that calls a tool as an editor of `org`. */
export function editorCalls(org: OrgScope) {
  const caller = memberOf(org, 'editor');
  return (name: string, input: unknown) => dispatch(registry, name, input, caller);
}

/** The output of a call that must succeed. */
export const ok = async (p: Promise<{ ok: boolean }>) => {
  const r = await p;
  if (!r.ok) throw new Error(JSON.stringify(r));
  return (r as unknown as { output: Record<string, unknown> }).output;
};

/** The output of `name` called as `caller`, which must succeed: read loosely, as a test reads it. */
export const call = async (caller: Caller, name: string, input: unknown) => {
  const r = await dispatch(registry, name, input, caller);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r)}`);
  return r.output as any;
};

/** `caller`'s org, with `before` run as its batch is committed: a change that lands between the handler's read and the batch. */
export function racing(caller: Caller, before: () => Promise<unknown>): Caller {
  const org = caller.org as OrgScope;
  let raced = false;
  const commit = async (writes: readonly Write[]) => {
    if (!raced) {
      raced = true;
      await before();
    }
    return org.commit(writes);
  };
  return { ...caller, org: new Proxy(org, { get: (t, k) => (k === 'commit' ? commit : Reflect.get(t, k)) }) };
}

/** An agent's limiter that never limits: for tests of what a tool does, not of the limits. */
export const unlimited: AgentLimiter = { take: async () => ({ ok: true }), audited: async () => {} };
