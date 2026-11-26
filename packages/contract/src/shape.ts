/**
 * Shapes declared once (#156): each checks a value in the contract's own words and, when it passes, gives back exactly
 * the shape, every key it does not declare left out. Its type is the interface in `shapes.ts`, held equal to the
 * declaration at compile time (`Same`), so a check can no longer drift from its type. No dependency: the player ships
 * the contract to the screen.
 */

/** A value read: exactly the shape, or the problems that stop it. */
export type Read<T> = { ok: true; value: T } | { ok: false; problems: string[] };

/** A shape: how a value is read. */
export interface Shape<T> {
  readonly read: (v: unknown) => Read<T>;
}

/** A field that may be left out: absent (undefined) passes, and stays absent. */
export interface Optional<T> {
  readonly optional: Shape<T>;
}

/** The type a shape reads. */
export type Infer<S> = S extends Shape<infer T> ? T : never;

/** `T` with every intersection flattened, at any depth, so two ways of writing one type compare equal. */
type Deep<T> = T extends readonly (infer U)[] ? (T extends unknown[] ? Deep<U>[] : readonly Deep<U>[]) : T extends object ? { [K in keyof T]: Deep<T[K]> } : T;

/** True when `A` and `B` are the same type, for a compile-time check that a shape reads its interface exactly. */
export type Same<A, B> = (<T>() => T extends Deep<A> ? 1 : 2) extends <T>() => T extends Deep<B> ? 1 : 2 ? true : false;

/** Holds at compile time only when its argument is `true`: `assertSame<Same<Infer<typeof s>, SyncRequest>>()`. */
export const assertSame = <_ extends true>() => undefined;

const ok = <T>(value: T): Read<T> => ({ ok: true, value });
const fail = <T>(problems: string[]): Read<T> => ({ ok: false, problems });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A value `test` accepts, as it is (a string, a number, a list of numbers): else `problem`, which may name the value. */
export const is = <T>(test: (v: unknown) => v is T, problem: string | ((v: unknown) => string)): Shape<T> => ({
  read: (v) => (test(v) ? ok(v) : fail([typeof problem === 'string' ? problem : problem(v)])),
});

/** Exactly `l`: a variant's tag. */
export const literal = <const L extends string>(l: L, problem: string): Shape<L> => is((v): v is L => v === l, problem);

/** A field that may be left out. */
export const optional = <T>(shape: Shape<T>): Optional<T> => ({ optional: shape });

type Fields = Record<string, Shape<unknown> | Optional<unknown>>;
type RequiredFields<F extends Fields> = { [K in keyof F as F[K] extends Shape<unknown> ? K : never]: F[K] extends Shape<infer T> ? T : never };
type Optionals<F extends Fields> = { [K in keyof F as F[K] extends Optional<unknown> ? K : never]?: F[K] extends Optional<infer T> ? T : never };
type Flat<T> = { [K in keyof T]: T[K] };
export type ObjectOf<F extends Fields> = Flat<RequiredFields<F> & Optionals<F>>;

/**
 * An object with these fields, read in their order, each one's problems in turn; a key it does not declare is left out.
 * Not an object at all: `notObject` alone.
 */
export function object<F extends Fields>(fields: F, notObject: string): Shape<ObjectOf<F>> {
  return {
    read(v) {
      if (!isObj(v)) return fail([notObject]);
      const problems: string[] = [];
      const value: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(fields)) {
        const own = Object.hasOwn(v, key) ? v[key] : undefined;
        const shape = 'optional' in field ? field.optional : field;
        if ('optional' in field && own === undefined) continue;
        const r = shape.read(own);
        if (r.ok) value[key] = r.value;
        else problems.push(...r.problems);
      }
      // Each field read by its own declared shape: the value holds exactly the declared fields, typed.
      return problems.length ? fail(problems) : ok(value as ObjectOf<F>);
    },
  };
}

/** `shape`, with any problem it has said as `message` alone: one problem for a group of fields. */
export const said = <T>(message: string, shape: Shape<T>): Shape<T> => ({
  read: (v) => {
    const r = shape.read(v);
    return r.ok ? r : fail([message]);
  },
});

/** `shape`, with each of its problems prefixed `where: `. */
export const within = <T>(where: string, shape: Shape<T>): Shape<T> => ({
  read: (v) => {
    const r = shape.read(v);
    return r.ok ? r : fail(r.problems.map((p) => `${where}: ${p}`));
  },
});

/**
 * A list of `item`, each problem prefixed with its 1-based place (`where 2: ...`). Not a list: `where must be a list`.
 * With `max`, a longer list is refused whole with `tooLong`, before any item is read (bounded work).
 */
export function listOf<T>(where: string, item: Shape<T>, bound?: { max: number; tooLong: string }): Shape<T[]> {
  return {
    read(v) {
      if (!Array.isArray(v)) return fail([`${where} must be a list`]);
      if (bound && v.length > bound.max) return fail([bound.tooLong]);
      const problems: string[] = [];
      const value: T[] = [];
      // Every place, a hole too (read as undefined): JSON has none, but a list read here is never shorter than it was.
      for (let i = 0; i < v.length; i++) {
        const r = item.read(v[i]);
        if (r.ok) value.push(r.value);
        else problems.push(...r.problems.map((p) => `${where} ${i + 1}: ${p}`));
      }
      return problems.length ? fail(problems) : ok(value);
    },
  };
}

/** A map of `value`, read entry by entry, each entry's problems prefixed `where(key): `. Not an object: `notObject`. */
export function record<T>(value: Shape<T>, where: (key: string) => string, notObject: string): Shape<Record<string, T>> {
  return {
    read(v) {
      if (!isObj(v)) return fail([notObject]);
      const problems: string[] = [];
      const entries: [string, T][] = [];
      for (const [key, x] of Object.entries(v)) {
        const r = value.read(x);
        if (r.ok) entries.push([key, r.value]);
        else problems.push(...r.problems.map((p) => `${where(key)}: ${p}`));
      }
      // fromEntries makes each key the map's own, so a `__proto__` key can never set its prototype.
      return problems.length ? fail(problems) : ok(Object.fromEntries(entries));
    },
  };
}

/** One of `cases`, picked by the value's `tag` field; a value with no case of its own: `noCase`. */
export function variant<C extends Record<string, Shape<unknown>>>(tag: string, cases: C, noCase: string): Shape<Infer<C[keyof C]>> {
  return {
    read(v) {
      const kind = isObj(v) ? v[tag] : undefined;
      if (typeof kind !== 'string' || !Object.hasOwn(cases, kind)) return fail([noCase]);
      // The case named by the tag reads the value: what it gives back is one of the cases' types.
      return cases[kind]!.read(v) as Read<Infer<C[keyof C]>>;
    },
  };
}

/** A shape read by hand, for a rule the others do not say (a check that depends on another field). */
export const custom = <T>(read: (v: unknown) => Read<T>): Shape<T> => ({ read });

export { fail as refused, ok as accepted };
