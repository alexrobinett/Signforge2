/**
 * How the CMS's loaders read data: tools, called as the signed-in member over the API binding.
 * Switching to a client cache later (docs/research/cms-data-layer.md) changes this and the
 * loaders, not the pages.
 */
import type { AssetView } from '~/lib/assets';
import type { GroupView, ScreenView } from '~/lib/screen-types';
import { callApi } from './api.server';

/** A tool's output, as the signed-in member; with `missing: 'null'`, null for a 404. */
export async function tool<T>(name: string, input: unknown): Promise<T>;
export async function tool<T>(name: string, input: unknown, opts: { missing: 'null' }): Promise<T | null>;
export async function tool<T>(name: string, input: unknown, opts?: { missing: 'null' }): Promise<T | null> {
  const res = await callApi(`/api/tools/${name}`, input);
  if (res.status === 404 && opts?.missing === 'null') return null;
  if (res.status === 403) {
    const refusal: { error?: string } = await res.clone().json();
    if (refusal.error === 'no_active_organization') throw new NoActiveOrg();
  }
  if (!res.ok) throw new Error(`${name} failed: ${res.status}`);
  // The tool's output, as its output schema in packages/tools says (checked there in tests).
  const output: T = await res.json();
  return output;
}

/** The member has no active org yet: the app shell asks them to pick or create one instead of showing the page. */
class NoActiveOrg extends Error {}

/** A loader's result, or `empty` while there is no active org to read from. */
export async function inOrg<T>(read: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof NoActiveOrg) return empty;
    throw err;
  }
}

/** One page of a list tool: its rows under the list's own key, and the cursor for the next. */
interface ListPage {
  next: string | null;
  screens?: ScreenView[];
  groups?: GroupView[];
  assets?: AssetView[];
}

/** Every page of a list tool, the rows `rows` picks from each. */
export async function all<T>(name: string, rows: (page: ListPage) => T[] | undefined): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await tool<ListPage>(name, { limit: 200, ...(cursor ? { cursor } : {}) });
    out.push(...(rows(page) ?? []));
    cursor = page.next ?? undefined;
  } while (cursor);
  return out;
}
