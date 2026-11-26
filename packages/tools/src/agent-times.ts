/**
 * Times as agents read them (#345). The tools give a time as ms since the epoch, which the CMS computes with; an agent
 * reads ISO 8601, as the times a person typed (a takeover's `endsAt`) and a feed's (`fetchedAt`) already are. So at the
 * agents' two doors, `/mcp`'s results and the drawer's tool outputs, each time a tool's output schema declares is made
 * ISO 8601, and `describe` says so of the fields it lists.
 *
 * A time is a number property whose name is `at`, `since`, or ends in At, Since or Until, declared as such in the
 * schema: the conversion follows the schema's paths (a `TimePlan`), never a value's own keys, so nothing inside an
 * opaque value (a snapshot's data, a spot's data, an audit entry's detail, a manifest) is touched. A duration (`*Ms`)
 * stays a number, and so does a number no date can hold.
 */

const isTimeKey = (key: string) => key === 'at' || key === 'since' || /[a-z](At|Since|Until)$/.test(key);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const isNumberType = (t: unknown) => t === 'number' || t === 'integer';

/** Where a value's declared times are: the value itself, its properties by name, or each item of an array. */
export interface TimePlan {
  time?: true;
  props?: Record<string, TimePlan>;
  items?: TimePlan;
}

const merge = (a: TimePlan | undefined, b: TimePlan | undefined): TimePlan | undefined => {
  if (!a || !b) return a ?? b;
  const props = { ...a.props };
  for (const [k, p] of Object.entries(b.props ?? {})) props[k] = merge(props[k], p) ?? p;
  const items = merge(a.items, b.items);
  return { ...(a.time || b.time ? { time: true } : {}), ...(Object.keys(props).length ? { props } : {}), ...(items ? { items } : {}) };
};

/** The times a JSON Schema declares, `key` the property it is under: undefined where it declares none. */
export function timePlan(schema: unknown, key?: string): TimePlan | undefined {
  if (!isRecord(schema)) return undefined;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (key !== undefined && isTimeKey(key) && types.some(isNumberType)) return { time: true };
  let plan: TimePlan | undefined;
  for (const branch of [schema.anyOf, schema.oneOf, schema.allOf].flatMap((b) => (Array.isArray(b) ? b : [])))
    plan = merge(plan, timePlan(branch, key));
  if (isRecord(schema.properties)) {
    const props = Object.fromEntries(Object.entries(schema.properties).flatMap(([k, s]) => {
      const p = timePlan(s, k);
      return p ? [[k, p]] : [];
    }));
    if (Object.keys(props).length) plan = merge(plan, { props });
  }
  const items = timePlan(schema.items);
  if (items) plan = merge(plan, { items });
  return plan;
}

/** A time in ms as ISO 8601, or the number as it is where no date holds it: never a throw. */
const isoOf = (ms: number) => (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : ms);

/** `value` with each time `plan` declares as ISO 8601, and nothing else changed. */
export function applyTimes(plan: TimePlan | undefined, value: unknown): unknown {
  if (!plan) return value;
  if (plan.time && typeof value === 'number') return isoOf(value);
  if (Array.isArray(value)) return plan.items ? value.map((v) => applyTimes(plan.items, v)) : value;
  if (!isRecord(value) || !plan.props) return value;
  const out = { ...value };
  for (const [k, p] of Object.entries(plan.props)) if (k in out) out[k] = applyTimes(p, out[k]);
  return out;
}

/** A number's JSON Schema as a time's: an ISO 8601 string, said so where its description said ms. */
function asTime(schema: unknown): unknown {
  if (!isRecord(schema)) return schema;
  const said = typeof schema.description === 'string' ? { description: schema.description.replace(/,? in ms since the epoch/, ', ISO 8601') } : {};
  if (isNumberType(schema.type)) return { ...schema, ...said, type: 'string', format: 'date-time' };
  // A nullable one, as `type: ['number', 'null']`.
  if (Array.isArray(schema.type) && schema.type.some(isNumberType))
    return { ...schema, ...said, type: schema.type.map((t) => (isNumberType(t) ? 'string' : t)), format: 'date-time' };
  if (Array.isArray(schema.anyOf)) return { ...schema, anyOf: schema.anyOf.map(asTime) };
  return schema;
}

/** JSON Schema properties, by name, as `applyTimes` makes their values: each time's number an ISO 8601 string, at any depth. */
export function agentTimeProperties(properties: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).map(([p, s]) => [p, isTimeKey(p) ? asTime(inSchema(s)) : inSchema(s)]));
}

/** A schema with every `properties` in it as `agentTimeProperties` makes them. */
function inSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(inSchema);
  if (!isRecord(schema)) return schema;
  return Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, k === 'properties' && isRecord(v) ? agentTimeProperties(v) : inSchema(v)]));
}
