/**
 * Staged writes: a change described as statements, run later in one D1 `batch()`.
 *
 * D1 has no interactive transactions, but a batch is atomic: if any statement fails, none take
 * effect. So a tool does not write; it stages. Each repository's `stage` builds the statements
 * for a change and returns the row as it will be once they run (ids, timestamps and column
 * defaults are fixed when staged, so the row is exact). The tool dispatcher then runs the
 * staged writes, the audit row and any idempotency record together with the scope's `commit`.
 *
 * A `Write` is opaque: only this package builds one, always stamped with its scope's org.
 */
import { getTableColumns, SQL } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';

type Db = DrizzleD1Database<Record<string, never>>;
type Query = Parameters<Db['batch']>[0][number];

const QUERY = Symbol('write');

/** One statement of a staged change. Run only by a scope's `commit`. */
export interface Write {
  readonly [QUERY]: Query;
}

/** A staged change: the statements to run, and the row (if any) as it will be afterwards. */
export interface Staged<T = void> {
  row: T;
  writes: Write[];
}

export const write = (query: unknown): Write => ({ [QUERY]: query as Query });
export const staged = <T>(row: T, ...queries: unknown[]): Staged<T> => ({ row, writes: queries.map(write) });

/** Run writes in one atomic batch. Nothing to write runs nothing. */
export async function commit(db: Db, writes: readonly Write[]): Promise<void> {
  if (!writes.length) return;
  const [first, ...rest] = writes.map((w) => w[QUERY]);
  await db.batch([first!, ...rest]);
}

interface ColumnInfo {
  default?: unknown;
  defaultFn?: () => unknown;
  onUpdateFn?: () => unknown;
}

/**
 * A caller's values without the fields it may never set (`Guarded` in ./scoped.ts): the org, the
 * id, the creation time and a draft's published version. `scoped` and `platform` both use it.
 */
export function strip<T extends object>(v: T): T {
  const { orgId: _o, id: _i, createdAt: _c, publishedJson: _pj, publishedAt: _pa, ...rest } = v as Record<string, unknown>;
  return rest as T;
}

/**
 * Every column's value for a new row: what was given, else its default, else null. Defaults are
 * resolved here, not by SQLite, so the staged row is the stored one.
 */
export function fullRow(table: SQLiteTable, values: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [key, col] of Object.entries(getTableColumns(table)) as [string, ColumnInfo][]) {
    let v = values[key];
    if (v === undefined) {
      if (col.defaultFn) v = col.defaultFn();
      else if (col.default !== undefined && !(col.default instanceof SQL)) v = col.default;
      else if (col.onUpdateFn) v = col.onUpdateFn();
      else v = null;
    }
    row[key] = v;
  }
  return row;
}

/** The fields an update sets: the patch's defined ones, plus `updatedAt`-style columns. */
export function updateSet(table: SQLiteTable, patch: Record<string, unknown>): Record<string, unknown> {
  const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  if (!Object.keys(set).length) return set;
  for (const [key, col] of Object.entries(getTableColumns(table)) as [string, ColumnInfo][]) {
    if (col.onUpdateFn && set[key] === undefined) set[key] = col.onUpdateFn();
  }
  return set;
}
