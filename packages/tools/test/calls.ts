// Calling tools in a test as the CMS does: as an editor of the org, through the registry.
import type { OrgScope } from '@signforge/db';
import { env } from 'cloudflare:workers';
import { dispatch, registry, type Caller } from '../src';

/** A function that calls a tool as an editor of `org`. */
export function editorCalls(org: OrgScope) {
  const caller: Caller = { org, role: 'editor', actor: { kind: 'user', id: 'user-1', clientId: 'cms' }, blobs: env.BLOBS };
  return (name: string, input: unknown) => dispatch(registry, name, input, caller);
}

/** The output of a call that must succeed. */
export const ok = async (p: Promise<{ ok: boolean }>) => {
  const r = await p;
  if (!r.ok) throw new Error(JSON.stringify(r));
  return (r as unknown as { output: Record<string, unknown> }).output;
};
