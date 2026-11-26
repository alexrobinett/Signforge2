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
import { eq, getTableColumns, SQL, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { organization } from './schema';

type Db = DrizzleD1Database<Record<string, never>>;
type Query = Parameters<Db['batch']>[0][number];

const QUERY = Symbol('write');
/** Guard conditions read in one query after a failed batch: D1 binds at most 100 values, and a draft's guard binds 5. */
const GUARDS_PER_READ = 15;
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
  /** Its condition, true while the change still holds: read with the others' after a failed batch, to find which failed in a few queries. */
  holds: SQL;
  /** The row's version now if it is no longer the row the change was made from, else undefined. Throws `NotInOrgError` if the row is gone, except a draft's promotion guard, which reports a vanished draft as version 0. */
  stale: () => Promise<number | undefined>;
}

/**
 * A change refused because its row is no longer the version it was made from: someone else
 * changed it since it was read. `version` is the row's version now; nothing was written.
 */
export class StaleVersionError extends Error {
  /** A failed batch guard's: the version its change was made from, to tell a row that moved from one that did not (#545). */
  readonly staged: number | undefined;
  constructor(
    readonly id: string,
    readonly version: number,
    options?: ErrorOptions & { message?: string; staged?: number },
  ) {
    super(options?.message ?? `${id} has changed since you read it; it is now version ${version}. Read it again and redo the change`, options);
    this.name = 'StaleVersionError';
    this.staged = options?.staged;
  }
}

/**
 * What a version guard aborts its batch with (`staleGuard`, ./scoped.ts): a JSON path that is not one,
 * which D1's error names, so a guard's abort is told from any other failure of the batch.
 */
const GUARD_ABORT = 'sf-guard: stale version';

/** A staged change: the statements to run, and the row (if any) as it will be afterwards. */
export interface Staged<T = void> {
  row: T;
  writes: Write[];
}

const write = (query: unknown): Write => ({ [QUERY]: query as Query });
export const staged = <T>(row: T, ...queries: unknown[]): Staged<T> => ({ row, writes: queries.map(write) });

/** A statement that fails its batch unless the row is still the version it was read at. */
const guard = (query: unknown, g: VersionGuard): Write => ({ [QUERY]: query as Query, [GUARD]: g });

/**
 * Run writes in one atomic batch. Nothing to write runs nothing. A batch failed by a version
 * guard throws `StaleVersionError` (`NotInOrgError` if the row is gone, but version 0 for a draft that vanished during promotion), so a caller can tell a
 * refusal from a fault; one a guard aborted (its abort names `GUARD_ABORT`) whose guards all hold again by
 * the time it is diagnosed, `StaleVersionError` with id `batch`. Any other failure is rethrown as it is. Returns how many rows each write
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
    // Which guard failed: their conditions read together, GUARDS_PER_READ to a query, so a batch of
    // many (a publish of 40 pins) costs a few reads to say so, not one each; then that one's version.
    const guards = writes.flatMap((w) => w[GUARD] ?? []);
    for (let at = 0; at < guards.length; at += GUARDS_PER_READ) {
      const part = guards.slice(at, at + GUARDS_PER_READ);
      const held = await db.get<Record<string, number>>(
        sql`SELECT ${sql.join(
          part.map((g, i) => sql`(CASE WHEN ${g.holds} THEN 1 ELSE 0 END) AS ${sql.identifier(`g${i}`)}`),
          sql`, `,
        )}`,
      );
      for (const [i, g] of part.entries()) {
        if (held?.[`g${i}`] === 1) continue;
        const now = await g.stale();
        // biome-ignore lint/style/useErrorCause: the cause is passed, in the options argument.
        if (now !== undefined) throw new StaleVersionError(g.id, now, { cause: err, staged: g.version });
      }
    }
    // A guard aborted it, but every one holds again as it is read (a change made and taken back since): still a
    // refusal, never a fault, though which row changed is no longer known. Any other failure is the database's.
    if (guards.length && err instanceof Error && err.message.includes(GUARD_ABORT))
      // biome-ignore lint/style/useErrorCause: the cause is passed, in the options argument.
      throw new StaleVersionError('batch', 0, { cause: err, message: 'Something changed while this was saved. Read it again and redo the change' });
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
    publishedVersion: _pv,
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

/**
 * A first statement for a batch that fails it unless `holds` is true when it runs, so a change made
 * from an old read writes nothing: `commit` then throws `StaleVersionError` with `id` and the
 * version `stale` reads now. Every version check inside a batch is one of these.
 */
export function staleGuard(db: Db, orgId: string, id: string, version: number, holds: SQL, stale: () => Promise<number | undefined>): Write {
  // A JSON path that is not one raises an error naming it, which aborts the batch: `commit` knows a guard's abort by it.
  const check = db
    .select({ ok: sql`json_extract('{}', CASE WHEN ${holds} THEN '$' ELSE ${GUARD_ABORT} END)` })
    .from(organization)
    .where(eq(organization.id, orgId));
  return guard(check, { id, version, holds, stale });
}
