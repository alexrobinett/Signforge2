/**
 * The command menu's entries: one per sidebar section, then one per tool the member's role may use,
 * read from `GET /api/tools` (the registry's `describeTools`, the list an agent gets). A tool's
 * form comes from its input's JSON Schema.
 */
import { SECTIONS, type Section } from './sections';

/** One input of a tool's form. `key` is an idempotency key: never shown, a fresh one per form. */
export type Field = { name: string; label: string; hint: string; required: boolean; nullable: boolean } & (
  | { type: 'text' | 'integer' | 'number' | 'boolean' | 'json' | 'key' }
  | { type: 'choice'; options: string[] }
);

/** A tool as the menu needs it. */
export interface ToolListing {
  name: string;
  description: string;
  mutates: boolean;
  fields: Field[];
}

export type CommandEntry =
  | { kind: 'go'; id: string; label: string; to: Section['to']; keywords: string[] }
  | { kind: 'tool'; id: string; label: string; tool: ToolListing; keywords: string[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === 'string' ? v : '');

/** A field from one property of the input schema. `anyOf [X, null]` is X, nullable. */
function field(name: string, schema: unknown, required: boolean): Field {
  const s = isRecord(schema) ? schema : {};
  const options = Array.isArray(s.anyOf) ? s.anyOf.filter(isRecord) : [];
  const nullable = options.some((o) => o.type === 'null');
  const nonNull = options.filter((o) => o.type !== 'null');
  const inner = nullable && nonNull.length === 1 ? { ...nonNull[0], description: s.description ?? nonNull[0]!.description } : s;
  const base = { name, label: name, hint: text(inner.description), required, nullable };
  if (name === 'idempotencyKey') return { ...base, type: 'key' };
  if (Array.isArray(inner.enum) && inner.enum.every((v) => typeof v === 'string')) return { ...base, type: 'choice', options: inner.enum };
  switch (inner.type) {
    case 'string':
      return { ...base, type: 'text' };
    case 'integer':
    case 'number':
    case 'boolean':
      return { ...base, type: inner.type };
    default:
      return { ...base, type: 'json' };
  }
}

/** The form for an input schema: its top-level properties, in order. */
function fieldsOf(schema: unknown): Field[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  const required = Array.isArray(schema.required) ? schema.required : [];
  return Object.entries(schema.properties).map(([name, prop]) => field(name, prop, required.includes(name)));
}

/** Parses `GET /api/tools`' body: `{ tools: [{ name, description, mutates, inputSchema, ... }] }`. */
export function parseToolList(body: unknown): ToolListing[] {
  if (!isRecord(body) || !Array.isArray(body.tools)) throw new Error('The tool list has no tools.');
  return body.tools.map((t: unknown) => {
    if (!isRecord(t) || typeof t.name !== 'string' || typeof t.description !== 'string' || typeof t.mutates !== 'boolean') {
      throw new Error('The tool list has a tool without a name, description or mutates.');
    }
    return { name: t.name, description: t.description, mutates: t.mutates, fields: fieldsOf(t.inputSchema) };
  });
}

/**
 * A tool's name for people: its description's first sentence, up to a colon, a semicolon or ", so"
 * (what follows says why, not what), without the paging every list tool describes.
 */
const labelOf = (description: string) =>
  (description.split(/(?<=\.)\s/)[0] ?? description)
    .split(/:|;|, so /)[0]!
    .replace(/, ordered by id|,? a page at a time|\.$/g, '')
    .trim();

/** Navigation first, in sidebar order, then the tools in registry order. */
export function commandEntries(tools: ToolListing[]): CommandEntry[] {
  return [
    ...SECTIONS.map((s): CommandEntry => ({ kind: 'go', id: `go:${s.to}`, label: `Go to ${s.label}`, to: s.to, keywords: [s.label] })),
    ...tools.map(
      (tool): CommandEntry => ({ kind: 'tool', id: `tool:${tool.name}`, label: labelOf(tool.description), tool, keywords: [tool.name, tool.description] }),
    ),
  ];
}

/** The value a choice field's select sends for null. */
export const NULL_CHOICE = '(null)';

/** Whether a tool opens a form: it does when any input is required. */
export const needsInput = (tool: ToolListing) => tool.fields.some((f) => f.required);

type InputResult = { ok: true; input: Record<string, unknown> } | { ok: false; field: string; message: string };

/**
 * A submitted form as the tool's input. An empty field is left out, or sent as null when the tool
 * requires it and allows null. The API checks the rest and refuses with its own message.
 */
export function toolInput(fields: Field[], form: FormData): InputResult {
  const input: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = form.get(f.name);
    const value = typeof raw === 'string' ? raw.trim() : '';
    const empty = !value && f.type !== 'key' && f.type !== 'boolean';
    if (value === NULL_CHOICE || (empty && f.required && f.nullable)) {
      input[f.name] = null;
      continue;
    }
    if (empty && !f.required) continue;
    switch (f.type) {
      case 'key':
        input[f.name] = crypto.randomUUID();
        break;
      case 'boolean':
        if (value || f.required) input[f.name] = value === 'on';
        break;
      case 'text':
      case 'choice':
        input[f.name] = value;
        break;
      case 'integer':
      case 'number': {
        const n = Number(value);
        if (!value || !Number.isFinite(n)) return { ok: false, field: f.name, message: `${f.label} must be a number.` };
        input[f.name] = n;
        break;
      }
      case 'json':
        try {
          input[f.name] = JSON.parse(value);
        } catch {
          return { ok: false, field: f.name, message: `${f.label} must be JSON, such as ["a", "b"] or {"key": "value"}.` };
        }
        break;
    }
  }
  return { ok: true, input };
}

/** A tool's output in a few words, for its toast: lists counted, a changed thing by name. */
export function resultText(output: unknown): string {
  if (!isRecord(output)) return 'Done';
  if (output.changed === false) return 'Nothing changed: it was already so';
  const parts = Object.entries(output).flatMap(([key, v]) => {
    if (Array.isArray(v)) return [`${v.length} ${key}`];
    if (isRecord(v) && typeof v.name === 'string') return [v.name];
    return [];
  });
  return parts.join(', ') || 'Done';
}
