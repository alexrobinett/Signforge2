/**
 * How the CMS's loaders read data: tools, called as the signed-in member over the API binding,
 * their answers read as the browser reads them (`answer` in src/lib/tools.ts): the output typed by
 * the tool's schema, a refusal a `Refusal` with its code. Switching to a client cache later
 * (docs/research/cms-data-layer.md) changes this and the loaders, not the pages.
 */
import { redirect } from '@tanstack/react-router';
import { getRequest } from '@tanstack/react-start/server';
import type { ToolInput } from '@signforge/tools/inputs';
import type { ToolName, ToolOutput } from '@signforge/tools/outputs';
import { signInBack } from '~/lib/paths';
import { answer, Refusal } from '~/lib/tools';
import { callApi } from './api.server';

type Outputs = { [N in ToolName]: ToolOutput<N> };

/** A tool's output, as the signed-in member; with `missing: 'null'`, null for a 404. A session that has ended goes to sign-in. */
export async function tool<N extends ToolName>(name: N, input: ToolInput<N>): Promise<Outputs[N]>;
export async function tool<N extends ToolName>(name: N, input: ToolInput<N>, opts: { missing: 'null' }): Promise<Outputs[N] | null>;
export async function tool<N extends ToolName>(name: N, input: ToolInput<N>, opts?: { missing: 'null' }): Promise<Outputs[N] | null> {
  const res = await callApi(`/api/tools/${name}`, input);
  if (res.status === 404 && opts?.missing === 'null') return null;
  if (res.status === 401) {
    // The way back, so it survives whichever redirect wins (the shell's too). Sign-in keeps it to this site.
    const req = getRequest();
    const back = signInBack(req.url, req.headers.get('referer'));
    throw redirect({ to: '/sign-in', search: back === '/' ? {} : { redirect: back } });
  }
  return answer(res, `${name} failed: ${res.status}`);
}

/** A loader's result, or `empty` while there is no active org to read from: the app shell then asks the member to pick or create one. */
export async function inOrg<T>(read: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof Refusal && err.code === 'no_active_organization') return empty;
    throw err;
  }
}

/** The list tools: those whose output pages, with `next`. */
type ListName = { [N in ToolName]: ToolOutput<N> extends { next: string | null } ? N : never }[ToolName];

/** Every page of a list tool, the rows `rows` picks from each; `input`, its filters. */
export async function all<N extends ListName, T>(name: N, rows: (page: Outputs[N]) => T[], input?: ToolInput<N>): Promise<T[]>;
/**
 * Typed over every list tool at once, where a page's limit and cursor join any list's filters; the signature above ties
 * `input` and `rows` to the tool named.
 */
export async function all<T>(name: ListName, rows: (page: Outputs[ListName]) => T[], input?: ToolInput<ListName>): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await tool(name, { ...input, limit: 200, ...(cursor ? { cursor } : {}) });
    out.push(...rows(page));
    cursor = page.next ?? undefined;
  } while (cursor);
  return out;
}
