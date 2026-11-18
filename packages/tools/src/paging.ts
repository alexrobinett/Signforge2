/**
 * Paging for list tools. Every `list_*` tool takes `limit` (default 50, at most 200) and an
 * optional `cursor`, and returns `next`: the cursor for the following page, or null on the last.
 *
 * A cursor is opaque to callers: the sort key of the last row returned, encoded. The next page
 * starts after that key, so rows added or removed between calls neither repeat nor shift the
 * rest. A cursor is only meaningful with the filters it was made with.
 *
 * Paging bounds what a call returns and the per-row work a tool does (groups' members, assets'
 * renditions). The repositories still read the org's whole list; SQL keyset paging is for when
 * an org's lists grow large enough to matter.
 */
import { z } from 'zod';
import { ToolError } from './tool';

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

/** The input fields a list tool adds to its own. */
export const pageInput = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_LIMIT)
    .default(DEFAULT_PAGE_LIMIT)
    .describe(`How many to return, 1 to ${MAX_PAGE_LIMIT}; default ${DEFAULT_PAGE_LIMIT}`),
  cursor: z.string().max(1000).optional().describe("The previous page's next, to get the page after it"),
};

/** The output field a list tool adds. */
export const nextOutput = z.string().nullable().describe('Pass as cursor to get the next page; null on the last page');

/** A sort key: compared element by element. */
export type SortKey = readonly (string | number)[];

const encode = (key: SortKey) => btoa(JSON.stringify(key)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function decode(cursor: string): SortKey {
  try {
    const key: unknown = JSON.parse(atob(cursor.replace(/-/g, '+').replace(/_/g, '/')));
    if (Array.isArray(key) && key.length && key.every((k) => typeof k === 'string' || typeof k === 'number')) return key;
  } catch {
    // fall through
  }
  throw new ToolError('invalid_input', 'cursor is not one a list returned; start again without it', [
    { path: 'cursor', message: 'not a cursor from this list' },
  ]);
}

/** Ascending, element by element; strings by code point. */
function compareKeys(a: SortKey, b: SortKey): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

/**
 * One page of `rows`, in the order `compare` gives their keys. `keyOf` must be unique per row
 * (end it with the id).
 */
export function page<T>(
  rows: readonly T[],
  keyOf: (row: T) => SortKey,
  { limit, cursor }: { limit: number; cursor?: string },
  compare: (a: SortKey, b: SortKey) => number = compareKeys,
): { rows: T[]; next: string | null } {
  const after = cursor === undefined ? undefined : decode(cursor);
  const sorted = rows.map((row) => ({ row, key: keyOf(row) })).sort((a, b) => compare(a.key, b.key));
  const rest = after ? sorted.filter((r) => compare(r.key, after) > 0) : sorted;
  const taken = rest.slice(0, limit);
  return { rows: taken.map((r) => r.row), next: rest.length > limit ? encode(taken.at(-1)!.key) : null };
}
