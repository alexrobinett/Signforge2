/**
 * Times as agents read them (#345). The tools give a time as ms since the epoch, which the CMS computes with; an agent
 * reads ISO 8601, as the times a person typed (a takeover's `endsAt`) and a feed's (`fetchedAt`) already are. So at the
 * agents' two doors, `/mcp`'s results and the drawer's tool outputs, every time is made ISO 8601, and `describe` says
 * so of the fields it lists. A time is a number under `at`, `since`, or a key ending in At or Since; a duration (`*Ms`)
 * stays a number.
 */

const isTimeKey = (key: string) => key === 'at' || key === 'since' || /[a-z](At|Since)$/.test(key);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `value` as an agent reads it: every time in ms since the epoch as ISO 8601, the rest as it is. */
export function agentTimes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(agentTimes);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, isTimeKey(k) && typeof v === 'number' && Number.isFinite(v) ? new Date(v).toISOString() : agentTimes(v)]),
  );
}

/** A number's JSON Schema as a time's: an ISO 8601 string, its description kept. */
function asTime(schema: unknown): unknown {
  if (!isRecord(schema)) return schema;
  if (schema.type === 'number' || schema.type === 'integer') return { ...schema, type: 'string', format: 'date-time' };
  // A nullable one, as `type: ['number', 'null']`.
  if (Array.isArray(schema.type) && schema.type.some((t) => t === 'number' || t === 'integer'))
    return { ...schema, type: schema.type.map((t) => (t === 'number' || t === 'integer' ? 'string' : t)), format: 'date-time' };
  if (Array.isArray(schema.anyOf)) return { ...schema, anyOf: schema.anyOf.map(asTime) };
  return schema;
}

/** JSON Schema properties, by name, as `agentTimes` makes their values: each time's number an ISO 8601 string, at any depth. */
export function agentTimeProperties(properties: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).map(([p, s]) => [p, isTimeKey(p) ? asTime(inSchema(s)) : inSchema(s)]));
}

/** A schema with every `properties` in it as `agentTimeProperties` makes them. */
function inSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(inSchema);
  if (!isRecord(schema)) return schema;
  return Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, k === 'properties' && isRecord(v) ? agentTimeProperties(v) : inSchema(v)]));
}
