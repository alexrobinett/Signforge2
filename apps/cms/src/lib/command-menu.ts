/**
 * The command menu's entries: one per sidebar section, then one per tool the member's role may use,
 * read from `GET /api/tools` (the registry's `describeTools`, the list an agent gets). A tool's
 * form comes from its input's JSON Schema. Typing also finds screens and groups by name (#180),
 * each with its own actions (`targetActions`).
 */
import type { GroupView, ScreenView } from './screen-types';
import { reachable } from './screen-status';
import { SECTIONS, type Section } from './sections';
import { findTargets } from './targets';

/** One input of a tool's form. `key` is an idempotency key: never shown, filled by `withKey`. */
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
  | { kind: 'tool'; id: string; label: string; tool: ToolListing; keywords: string[] }
  /** `start_takeover` for a member who may publish: the takeover dialog, which sends it at once, as the Schedule page's does (#253). */
  | { kind: 'takeover'; id: string; label: string; tool: ToolListing; keywords: string[] }
  | { kind: 'org'; id: string; label: string; action: 'switch' | 'create'; keywords: string[] };

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

/**
 * Navigation first, in sidebar order, then the tools in registry order. A takeover is sent at once
 * wherever the CMS offers it, so `start_takeover`, which only drafts one, opens the takeover dialog
 * for a member who may publish; one who may not can only draft it, as its own words say.
 */
export function commandEntries(tools: ToolListing[]): CommandEntry[] {
  const publishes = tools.some((t) => t.name === 'publish');
  return [
    ...SECTIONS.map((s): CommandEntry => ({ kind: 'go', id: `go:${s.to}`, label: `Go to ${s.label}`, to: s.to, keywords: [s.label] })),
    ...tools.map((tool): CommandEntry => {
      const entry = { id: `tool:${tool.name}`, tool, keywords: [tool.name, tool.description] };
      return tool.name === 'start_takeover' && publishes
        ? { kind: 'takeover', label: 'Take over screens now…', ...entry }
        : { kind: 'tool', label: labelOf(tool.description), ...entry };
    }),
  ];
}

/** The organization commands: switching only for a member of two or more orgs (#182). */
export function orgCommands(orgCount: number): CommandEntry[] {
  const create: CommandEntry = { kind: 'org', id: 'org:create', label: 'Create organization…', action: 'create', keywords: ['new organization'] };
  if (orgCount < 2) return [create];
  return [{ kind: 'org', id: 'org:switch', label: 'Switch organization…', action: 'switch', keywords: ['change organization'] }, create];
}

/** The value a choice field's select sends for null. */
export const NULL_CHOICE = '(null)';

/** Whether a tool opens a form: it does when any input is required. */
export const needsInput = (tool: ToolListing) => tool.fields.some((f) => f.required);

type InputResult = { ok: true; input: Record<string, unknown> } | { ok: false; field: string; message: string };

/**
 * A submitted form as the tool's input, without its idempotency key (`withKey`). An empty field is
 * left out, or sent as null when the tool requires it and allows null. The API checks the rest
 * and refuses with its own message.
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
        // Filled by `withKey`, which knows whether this is a call already sent.
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

/** A call sent and not yet answered with success: its tool, its input without the key, and the key. */
export interface PendingCall {
  tool: string;
  input: string;
  key: string;
}

/**
 * The input with its idempotency key, if the tool takes one, and the call as now pending. The
 * same input to the same tool as the pending call is that call again, after a lost answer or a
 * refusal, and keeps its key, so the server does it once; anything else is a new call.
 */
export function withKey(
  tool: ToolListing,
  input: Record<string, unknown>,
  pending: PendingCall | null,
): { input: Record<string, unknown>; pending: PendingCall | null } {
  const field = tool.fields.find((f) => f.type === 'key');
  if (!field) return { input, pending: null };
  const same = JSON.stringify(input);
  const key = pending?.tool === tool.name && pending.input === same ? pending.key : crypto.randomUUID();
  return { input: { ...input, [field.name]: key }, pending: { tool: tool.name, input: same, key } };
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

/** A screen or a group ⌘K found, whose actions are showing. */
export type CommandTarget = { kind: 'screen'; id: string } | { kind: 'group'; id: string };

/**
 * What ⌘K offers on a screen or a group it found. A new action is a case here, a line in
 * `targetActions`, and a case in the store's `runTargetAction` (src/state/command-menu.ts).
 */
export type TargetAction =
  | { kind: 'open-screen'; label: string; screenId: string }
  | { kind: 'open-group'; label: string; groupId: string }
  /** The schedule's entry dialog, aimed at the screen (#181). */
  | { kind: 'play-here'; label: string; screenId: string }
  /** The takeover dialog, aimed at the screen (#181). */
  | { kind: 'take-over'; label: string; screenId: string }
  | { kind: 'tool'; label: string; tool: 'identify_screen' | 'restart_screen'; screenId: string; screenName: string; done: string };

/**
 * A screen's or a group's actions, those the member's role allows (the tools the shell listed). A
 * screen gets commands only once `checked`, its record read since the menu opened: a cached one
 * may be revoked since. Playing a playlist on it or taking it over opens the schedule's dialogs
 * (#181). A revoked screen can only be opened, and one that cannot be reached is not restarted (#253).
 */
export function targetActions(
  target: { kind: 'screen'; screen: ScreenView } | { kind: 'group'; group: GroupView },
  tools: ToolListing[],
  checked: boolean,
): TargetAction[] {
  if (target.kind === 'group') return [{ kind: 'open-group', label: 'Show its screens', groupId: target.group.id }];
  const { id: screenId, name: screenName, status } = target.screen;
  const listed = (tool: string) => status !== 'revoked' && tools.some((t) => t.name === tool);
  const may = (tool: string) => checked && listed(tool);
  const actions: TargetAction[] = [{ kind: 'open-screen', label: 'Open', screenId }];
  // These open a dialog, sending nothing: they need no read of this opening, though not on a revoked screen.
  if (listed('create_schedule_entry')) actions.push({ kind: 'play-here', label: 'Play a playlist here…', screenId });
  // A takeover is started, then published at once: an editor where only owners publish keeps start_takeover, not publish.
  if (listed('start_takeover') && listed('publish')) actions.push({ kind: 'take-over', label: 'Take over…', screenId });
  if (may('identify_screen'))
    actions.push({
      kind: 'tool',
      label: 'Identify (10 s)',
      tool: 'identify_screen',
      screenId,
      screenName,
      done: 'Sent. The screen shows its name for 10 seconds, if it is connected.',
    });
  if (may('restart_screen') && reachable(target.screen))
    actions.push({
      kind: 'tool',
      label: 'Restart player',
      tool: 'restart_screen',
      screenId,
      screenName,
      done: 'Sent. The player restarts and plays from its cache at once.',
    });
  return actions;
}

/**
 * A found screen's or group's item key, from its keywords: cmdk reads an item's keywords only when
 * its value changes, so a change to them remounts it. JSON, as a join would make "North,East" one
 * group's name and two groups' the same.
 */
export const targetItemKey = (value: string, keywords: string[]) => `${value}:${JSON.stringify(keywords)}`;

/** The screens and groups ⌘K lists for a search, as its item values in the order it lists them: screens, then groups, each by name. */
export function foundValues(query: string, screens: readonly ScreenView[], groups: readonly GroupView[]): string[] {
  if (!query.trim()) return [];
  const found = findTargets(query, screens, groups);
  return [...found.screens.map((s) => `screen:${s.id}`), ...found.groups.map((g) => `group:${g.id}`)];
}

/** The item selected, and the found items it was selected among (`foundValues`, as JSON). */
export interface Selection {
  value: string;
  among: string;
}

/**
 * The item ⌘K shows selected. cmdk moves its selection only when the search changes, so a list read
 * that lands after typing would leave a tool selected over the screens it found: cmdk's own pick,
 * made among other found items, gives way to the first found. One the member `moved` to stays.
 * Empty lets cmdk select its first item.
 */
export function selectedItem(selection: Selection | null, found: readonly string[], moved: boolean): string {
  if (selection && (moved || selection.among === JSON.stringify(found))) return selection.value;
  return found[0] ?? selection?.value ?? '';
}

/** The keys cmdk 1.1.1 moves its selection with: arrows, Home and End, and its vim bindings (Ctrl+N, J, P, K). Not PageUp or PageDown, which it ignores. */
const MOVE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'Home', 'End']);

/** Whether a key press is the member moving ⌘K's selection themselves (`moved`). With Alt, cmdk moves to the next or previous group. */
export const movesSelection = (e: { key: string; ctrlKey: boolean }) => MOVE_KEYS.has(e.key) || (e.ctrlKey && ['n', 'j', 'p', 'k'].includes(e.key));

/**
 * Whether a pointer move is the member moving ⌘K's selection: cmdk selects by pointer only over an
 * enabled item, so a move over the search, the footer or the item already selected is not one.
 */
export const pointerMovesSelection = (under: { value: string; disabled: boolean } | null, selected: string) =>
  under !== null && !under.disabled && under.value !== selected;
