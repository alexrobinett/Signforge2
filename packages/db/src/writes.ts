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
const GUARD = Symbol('guard');

/** One statement of a staged change. Run only by a scope's `commit`. */
export interface Write {
  readonly [QUERY]: Query;
  /** On a version guard (./scoped.ts): which row it checked, and how to read its version now. */
  readonly [GUARD]?: VersionGuard;
}

interface VersionGuard {
  id: string;
  /** The version the change was made from. */
  version: number;
  /** The row's version now if it is no longer the row the change was made from, else undefined. Throws `NotInOrgError` if the row is gone, except a draft's promotion guard, which reports a vanished draft as version 0. */
  stale: () => Promise<number | undefined>;
}

/**
 * A change refused because its row is no longer the version it was made from: someone else
 * changed it since it was read. `version` is the row's version now; nothing was written.
 */
export class StaleVersionError extends Error {
  constructor(
    readonly id: string,
    readonly version: number,
    options?: ErrorOptions,
  ) {
    super(`${id} has changed since you read it; it is now version ${version}. Read it again and redo the change`, options);
    this.name = 'StaleVersionError';
  }
}

/** A staged change: the statements to run, and the row (if any) as it will be afterwards. */
export interface Staged<T = void> {
  row: T;
  writes: Write[];
}

const write = (query: unknown): Write => ({ [QUERY]: query as Query });
export const staged = <T>(row: T, ...queries: unknown[]): Staged<T> => ({ row, writes: queries.map(write) });

/** A statement that fails its batch unless the row is still the version it was read at. */
export const guard = (query: unknown, g: VersionGuard): Write => ({ [QUERY]: query as Query, [GUARD]: g });

/**
 * Run writes in one atomic batch. Nothing to write runs nothing. A batch failed by a version
 * guard throws `StaleVersionError` (`NotInOrgError` if the row is gone, but version 0 for a draft that vanished during promotion), so a caller can tell a
 * refusal from a fault; any other failure is rethrown as it is. Returns how many rows each write
 * changed, as D1 counts them (with its triggers' and cascades'; 0 for a guard), which `testScope`
 * reports from (./testing.ts).
 */
export async function commit(db: Db, writes: readonly Write[]): Promise<number[]> {
  if (!writes.length) return [];
  const [first, ...rest] = writes.map((w) => w[QUERY]);
  try {
    const results = await db.batch([first!, ...rest]);
    return results.map((r) => (r as { meta?: { changes?: number } }).meta?.changes ?? 0);
  } catch (err) {
    for (const g of writes.flatMap((w) => w[GUARD] ?? [])) {
      const now = await g.stale();
      // biome-ignore lint/style/useErrorCause: the cause is passed, in the options argument.
      if (now !== undefined) throw new StaleVersionError(g.id, now, { cause: err });
    }
    throw err;
  }
}

interface ColumnInfo {
  default?: unknown;
  defaultFn?: () => unknown;
  onUpdateFn?: () => unknown;
}

/**
 * A caller's values without the fields it may never set (`Guarded` in ./scoped.ts): the org, the
 * id, the creation time, the row's version, a draft's incarnation, the org's publish revision
 * and a draft's published version. `scoped` and `platform` both use it.
 */
export function strip<T extends object>(v: T): T {
  const {
    orgId: _o,
    id: _i,
    createdAt: _c,
    rowVersion: _v,
    incarnation: _n,
    publishRevision: _r,
    publishedJson: _pj,
    publishedAt: _pa,
    ...rest
  } = v as Record<string, unknown>;
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
