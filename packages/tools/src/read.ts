/**
 * `read` and `describe` (#345): one tool an agent reads every type with, and one that says what a type holds. They run
 * today's list and get tools in-process, so a type reads exactly what its tool reads, through the same scoped
 * repositories, with that tool's scope and role checked as the dispatcher checks them: one agent call is one count
 * against its limits and one D1 budget. Today's tools stay in the registry for the CMS and for clients that call them
 * by name; agents are no longer listed them (`READ_TOOLS`).
 */
import { z } from 'zod';
import { type Grant, permits } from './dispatch';
import { outputs } from './outputs';
import { id } from './fields';
import { pageInput } from './paging';
import { type AnyTool, defineTool, ToolError, type ToolContext } from './tool';

type Row = Record<string, unknown>;

/** How a type is read: its list tool and the key its rows are under, its get tool by id, or one tool that answers whole. */
interface TypeDef {
  about: string;
  list?: { tool: string; items: string };
  get?: { tool: string; id: string; item: string };
  one?: string;
  /** What `detail: "summary"` (the default) keeps of each row: its fields, or a shape of its own. */
  summary: readonly string[] | ((row: Row) => Row);
}

const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A template's summary: its key and name, and its newest approved version's id, description, orientations and field
 * names, which is what choosing one and filling a spot need. Its versions' whole manifests and check reports are `full`.
 */
function templateSummary(row: Row): Row {
  const versions = Array.isArray(row.versions) ? row.versions.filter(isRow) : [];
  const latest = versions.filter((v) => v.status === 'approved').at(-1);
  const manifest = isRow(latest?.manifest) ? latest.manifest : {};
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    latestApproved: latest
      ? {
          id: latest.id,
          version: latest.version,
          description: manifest.description ?? null,
          orientations: manifest.orientations ?? [],
          fields: isRow(manifest.fields) ? Object.keys(manifest.fields) : [],
        }
      : null,
  };
}

export const READ_TYPES = {
  screen: {
    about: 'screens: name, state, settings, labels, what they play',
    list: { tool: 'list_screens', items: 'screens' },
    get: { tool: 'get_screen', id: 'screenId', item: 'screen' },
    summary: ['id', 'name', 'state', 'lastSeenAt', 'timezone', 'orientation', 'labels', 'version'],
  },
  screen_status: {
    about: "each screen's state and when it was last heard from, cheaply",
    list: { tool: 'list_screen_status', items: 'screens' },
    summary: ['id', 'state', 'lastSeenAt'],
  },
  group: { about: 'screen groups and their screens', list: { tool: 'list_groups', items: 'groups' }, summary: ['id', 'name', 'screenIds', 'version'] },
  label_key: {
    about: 'the label keys screens carry, and their values',
    list: { tool: 'list_label_keys', items: 'keys' },
    summary: ['key', 'system', 'screens', 'values'],
  },
  publish: {
    about: 'publishes, newest first, and how each rolled out',
    list: { tool: 'list_publishes', items: 'publishes' },
    get: { tool: 'get_publish', id: 'publishId', item: 'publish' },
    summary: ['id', 'revision', 'by', 'createdAt', 'reached', 'screens', 'playing', 'changes'],
  },
  publish_request: {
    about: 'requests to publish drafts, and their decisions',
    list: { tool: 'list_publish_requests', items: 'requests' },
    get: { tool: 'get_publish_request', id: 'publishRequestId', item: 'request' },
    summary: ['id', 'status', 'requestedBy', 'drafts', 'reason', 'createdAt', 'publishId', 'version'],
  },
  draft_count: {
    about: 'how many spots, playlists and schedule entries are unpublished',
    one: 'count_drafts',
    summary: ['spots', 'playlists', 'scheduleEntries'],
  },
  template: {
    about: 'templates a spot can use; summary: key, name, the latest approved version and its fields',
    list: { tool: 'list_templates', items: 'templates' },
    get: { tool: 'get_template', id: 'templateId', item: 'template' },
    summary: templateSummary,
  },
  asset: {
    about: 'images and videos',
    list: { tool: 'list_assets', items: 'assets' },
    get: { tool: 'get_asset', id: 'assetId', item: 'asset' },
    summary: ['id', 'name', 'kind', 'status', 'width', 'height', 'durationMs', 'usageCount'],
  },
  font: { about: 'fonts a brand kit can use', list: { tool: 'list_fonts', items: 'fonts' }, summary: ['id', 'family', 'roles', 'weights', 'available'] },
  brand_kit: {
    about: 'brand kits: colors, fonts, logo, where they apply',
    list: { tool: 'list_brand_kits', items: 'brandKits' },
    get: { tool: 'get_brand_kit', id: 'brandKitId', item: 'brandKit' },
    summary: ['id', 'name', 'colors', 'displayFont', 'bodyFont', 'isDefault', 'version'],
  },
  data_source: {
    about: 'live data sources (feeds, tables, weather); full with ids adds the latest snapshot',
    list: { tool: 'list_data_sources', items: 'dataSources' },
    get: { tool: 'get_data_source', id: 'dataSourceId', item: 'dataSource' },
    summary: ['id', 'name', 'format', 'refreshS', 'lastError', 'version'],
  },
  spot: {
    about: 'spots: what plays, as drafted; full has their data',
    list: { tool: 'list_spots', items: 'spots' },
    get: { tool: 'get_spot', id: 'spotId', item: 'spot' },
    summary: ['id', 'name', 'kind', 'durationMs', 'templateVersionId', 'url', 'version', 'published', 'draftChanged'],
  },
  agent_draft: {
    about: "what an agent's draft of a spot or playlist changes (filter: spotId or playlistId)",
    one: 'get_agent_draft',
    summary: ['kind', 'id', 'version', 'by', 'rejected', 'changes'],
  },
  playlist: {
    about: 'playlists and the spots they play, in order',
    list: { tool: 'list_playlists', items: 'playlists' },
    get: { tool: 'get_playlist', id: 'playlistId', item: 'playlist' },
    summary: ['id', 'name', 'spotIds', 'isDefault', 'version', 'published', 'draftChanged'],
  },
  schedule_entry: {
    about: 'schedule entries and takeovers: which playlist plays where and when',
    list: { tool: 'list_schedule_entries', items: 'entries' },
    summary: [
      'id',
      'playlistId',
      'target',
      'groupId',
      'screenId',
      'priority',
      'startDate',
      'endDate',
      'days',
      'from',
      'to',
      'startsAt',
      'endsAt',
      'takeover',
      'version',
      'draftChanged',
    ],
  },
  audit_entry: {
    about: 'the audit log: who changed what, newest first',
    list: { tool: 'list_audit_log', items: 'entries' },
    summary: ['at', 'actor', 'action', 'target'],
  },
  member: {
    about: "the organization's members and their roles",
    list: { tool: 'list_members', items: 'members' },
    summary: ['id', 'userId', 'name', 'email', 'role'],
  },
  org: {
    about: 'the organization: its id and name, your role and scopes, its settings and AI provider',
    summary: ['id', 'name', 'role', 'scopes', 'settings', 'aiProvider'],
  },
  connection: {
    about: "connections to a provider's data",
    list: { tool: 'list_connections', items: 'connections' },
    summary: ['id', 'provider', 'account', 'status', 'lastError'],
  },
  alert_delivery: {
    about: "alerts sent to the org's channels",
    list: { tool: 'list_alert_deliveries', items: 'deliveries' },
    summary: ['id', 'channel', 'eventType', 'status', 'attempts', 'lastError'],
  },
  alert_channels: { about: "the org's alert channels", one: 'get_alert_channels', summary: ['slack', 'webhook'] },
  invitation: {
    about: 'pending invitations to the organization',
    list: { tool: 'list_invitations', items: 'invitations' },
    summary: ['id', 'email', 'role', 'status', 'expiresAt'],
  },
} as const satisfies Record<string, TypeDef>;

export type ReadType = keyof typeof READ_TYPES;
const TYPE_NAMES = Object.keys(READ_TYPES).filter((t): t is ReadType => t in READ_TYPES);
const defOf = (type: ReadType): TypeDef => READ_TYPES[type];

/** The `org` type's tools: its settings and its AI provider. */
const ORG_TOOLS = ['get_org_settings', 'get_ai_provider'];

/** The registry tools a type reads with. */
export function toolsOf(type: ReadType): string[] {
  const def = defOf(type);
  if (type === 'org') return ORG_TOOLS;
  return [def.list?.tool, def.get?.tool, def.one].filter((t): t is string => t !== undefined);
}

/** Today's read tools that `read` stands for: kept in the registry, listed to no agent. */
export const READ_TOOLS: ReadonlySet<string> = new Set(TYPE_NAMES.flatMap(toolsOf));

/** The registry's tools, which `read` runs and describes: passed in, as the registry is built with `read` in it. */
export type Tools = ReadonlyMap<string, AnyTool<any>>;

const toolNamed = (tools: Tools, name: string): AnyTool<any> => {
  const tool = tools.get(name);
  if (!tool) throw new Error(`read: no registry tool ${name}`);
  return tool;
};

/** The types `grant` may read: every tool the type reads with is one it may use, and none is a person's alone. */
export const readTypes = (tools: Tools, grant: Grant): ReadType[] =>
  TYPE_NAMES.filter((type) => toolsOf(type).every((name) => permits(grant, toolNamed(tools, name)) && !toolNamed(tools, name).people));

const typeField = (types: readonly ReadType[]) =>
  z.enum(types.length ? types : TYPE_NAMES).describe('What to read; describe(type) says its filters and fields');

/** `read`'s input, its type one of `types`. */
export const readInput = (types: readonly ReadType[]) =>
  z.object({
    type: typeField(types),
    ids: z.array(id('record')).min(1).max(50).optional().describe('Read these by id (each in full with detail full); omit to list'),
    filter: z.record(z.string(), z.unknown()).optional().describe("The type's filters, as describe lists them"),
    query: z.string().min(1).max(100).optional().describe('Words in the name, where the type can search (asset, audit_entry)'),
    detail: z.enum(['summary', 'full']).optional().describe('summary (the default): the fields most tasks need; full: every field'),
    fields: z.array(z.string()).min(1).max(40).optional().describe('Only these top-level fields of each row'),
    ...pageInput,
  });

/** `describe`'s input, its type one of `types`. */
export const describeInput = (types: readonly ReadType[]) => z.object({ type: typeField(types) });

/** The JSON Schema properties of one of a tool's outputs: the rows under `key`, or the output itself. */
function propertiesOf(tools: Tools, tool: string, key?: string): Record<string, unknown> {
  const schema: Row = z.toJSONSchema(toolNamed(tools, tool).output, { io: 'output', unrepresentable: 'any' });
  const props = isRow(schema.properties) ? schema.properties : {};
  if (key === undefined) return props;
  const at = props[key];
  const item = isRow(at) && at.type === 'array' && isRow(at.items) ? at.items : at;
  return isRow(item) && isRow(item.properties) ? item.properties : {};
}

/** Every top-level field a row of `type` can have, with its JSON Schema: a list's rows, and what its get adds. */
function fieldsOf(tools: Tools, type: ReadType): Record<string, unknown> {
  const def = defOf(type);
  if (type === 'org')
    return {
      id: { type: 'string' },
      name: { type: 'string' },
      role: { type: 'string' },
      scopes: { type: 'array', items: { type: 'string' } },
      settings: propertiesOf(tools, 'get_org_settings', 'settings'),
      aiProvider: propertiesOf(tools, 'get_ai_provider').provider,
    };
  if (def.one) return propertiesOf(tools, def.one);
  const fromGet = def.get ? { ...propertiesOf(tools, def.get.tool, def.get.item), ...propertiesOf(tools, def.get.tool) } : {};
  if (def.get) delete fromGet[def.get.item];
  return { ...(def.list ? propertiesOf(tools, def.list.tool, def.list.items) : {}), ...fromGet };
}

/** A type's filters: its list (or one) tool's input, less paging and what `read` takes itself. */
function filtersOf(tools: Tools, type: ReadType): Record<string, unknown> {
  const def = defOf(type);
  const tool = def.list?.tool ?? def.one;
  if (!tool) return {};
  const schema: Row = z.toJSONSchema(toolNamed(tools, tool).input, { io: 'input', unrepresentable: 'any' });
  const { limit: _limit, cursor: _cursor, query: _query, ...filters } = isRow(schema.properties) ? schema.properties : {};
  return filters;
}

const searchable = (tools: Tools, type: ReadType) => {
  const tool = defOf(type).list?.tool;
  return tool !== undefined && 'query' in propertiesOfInput(tools, tool);
};
const propertiesOfInput = (tools: Tools, tool: string): Row => {
  const schema: Row = z.toJSONSchema(toolNamed(tools, tool).input, { io: 'input', unrepresentable: 'any' });
  return isRow(schema.properties) ? schema.properties : {};
};

/** Refused with what to send instead: the model learns the type's shape from the refusal, or from describe. */
const teach = (message: string, type: ReadType, options?: ErrorOptions) =>
  new ToolError('invalid_input', `${message} (or call describe({ type: '${type}' }))`, undefined, false, options);

/** Runs a registry read for `ctx`'s caller (`ctx.run`, the dispatcher's own checks); a wrong input says how to send it. */
async function runRead(ctx: ToolContext<unknown>, name: string, input: Row, type: ReadType): Promise<Row> {
  let output: unknown;
  try {
    output = await ctx.run(name, input);
  } catch (err) {
    if (err instanceof ToolError && err.code === 'invalid_input') throw teach(err.message.replaceAll('\n', ' '), type, { cause: err });
    throw err;
  }
  if (!isRow(output)) throw new Error(`read: ${name} answered no object`);
  return output;
}

type ReadInput = z.output<ReturnType<typeof readInput>>;

/** The mutating tools named for a type: `rename_screen`, `screen_command` for screen. By name, so a new tool is found as it is added. */
const changedBy = (tools: Tools, type: ReadType) =>
  [...tools.values()].filter((t) => t.mutates && !t.people && new RegExp(`(^|_)${type}(s|_|$)`).test(t.name)).map((t) => t.name);

/**
 * `read` and `describe` over `tools`, the registry's other tools: built by the registry, which holds them too, so neither
 * module imports the other.
 */
export function readTools(tools: Tools) {
  const read = defineTool({
    name: 'read',
    description: [
      "Read anything in the organization. Give its type, and ids to read those (up to 50), or a filter, to list a page of them; pass next as cursor for the next page. detail is summary by default: the fields most tasks need, with names beside ids; full has every field, and with ids what the type's own page shows (a screen's credentials and events, a publish's rollout, a data source's snapshot). fields picks fields. A wrong filter or field is refused with the right ones. Types:",
      ...TYPE_NAMES.map((t) => `${t}: ${defOf(t).about}.`),
      'Returns { type, items, next }.',
    ].join(' '),
    scope: 'content:read',
    minRole: 'viewer',
    mutates: false,
    input: readInput(TYPE_NAMES),
    listedInput: (grant) => readInput(readTypes(tools, grant)),
    output: outputs.read,
    example: { type: 'screen', filter: { selector: { all: [{ key: 'orientation', op: 'eq', values: ['portrait'] }] } } },
    handler: async (ctx) => {
      const { type, ids, filter = {}, query, detail = 'summary', fields, limit, cursor } = ctx.input satisfies ReadInput;
      const def = defOf(type);
      const known = Object.keys(fieldsOf(tools, type));
      const wrong = (fields ?? []).filter((f) => !known.includes(f));
      if (wrong.length) throw teach(`${type} has no field ${wrong.join(', ')}: its fields are ${known.join(', ')}`, type);
      const filters = Object.keys(filtersOf(tools, type));
      const unknown = Object.keys(filter).filter((k) => !filters.includes(k));
      if (unknown.length)
        throw teach(`${type} has no filter ${unknown.join(', ')}: ${filters.length ? `its filters are ${filters.join(', ')}` : 'it takes none'}`, type);
      if (query !== undefined && !searchable(tools, type))
        throw teach(`${type} cannot be searched by query: ${TYPE_NAMES.filter((t) => searchable(tools, t)).join(' and ')} can`, type);
      if (ids && !def.get) throw teach(`${type} cannot be read by ids: list it, with a filter`, type);

      const shown = (row: Row): Row => {
        if (fields) return Object.fromEntries(fields.filter((f) => f in row).map((f) => [f, row[f]]));
        if (detail === 'full') return row;
        const { summary } = def;
        return typeof summary === 'function' ? summary(row) : Object.fromEntries(summary.filter((f) => f in row).map((f) => [f, row[f]]));
      };

      if (type === 'org') {
        const [{ settings }, { provider }] = await Promise.all([runRead(ctx, 'get_org_settings', {}, type), runRead(ctx, 'get_ai_provider', {}, type)]);
        const row = { id: ctx.org.orgId, name: await ctx.org.name(), role: ctx.role, scopes: [...ctx.scopes], settings, aiProvider: provider };
        return { type, items: [shown(row)], next: null };
      }
      if (def.one) return { type, items: [shown(await runRead(ctx, def.one, filter, type))], next: null };
      if (ids && def.get) {
        const { get } = def;
        const rows = [];
        for (const id of ids) {
          const { [get.item]: main, ...extras } = await runRead(ctx, get.tool, { [get.id]: id }, type);
          rows.push(shown({ ...(isRow(main) ? main : {}), ...extras }));
        }
        return { type, items: rows, next: null };
      }
      if (!def.list) throw teach(`${type} cannot be listed`, type);
      const out = await runRead(ctx, def.list.tool, { ...filter, ...(query === undefined ? {} : { query }), limit, cursor }, type);
      const rows = Array.isArray(out[def.list.items]) ? out[def.list.items] : [];
      const next = typeof out.next === 'string' ? out.next : null;
      return { type, items: (Array.isArray(rows) ? rows : []).filter(isRow).map(shown), next, ...(typeof out.total === 'number' ? { total: out.total } : {}) };
    },
  });

  const describe = defineTool({
    name: 'describe',
    description:
      'What read gives for a type: its filters, whether it reads by ids or searches, the fields of summary and of full with what each means, and the tools that change it. Call it once for a type before you filter it or pick its fields. Returns { type, about, ids, query, filters, summary, fields, changedBy }.',
    scope: 'content:read',
    minRole: 'viewer',
    mutates: false,
    input: describeInput(TYPE_NAMES),
    listedInput: (grant) => describeInput(readTypes(tools, grant)),
    output: outputs.describe,
    example: { type: 'spot' },
    handler: async ({ input: { type }, role, scopes }) => {
      const grant: Grant = { role, scopes, editorsPublish: true };
      if (!toolsOf(type).every((name) => permits(grant, toolNamed(tools, name))))
        throw new ToolError('forbidden', `reading ${type} is not open to this caller`);
      const def = defOf(type);
      const { summary } = def;
      return {
        type,
        about: def.about,
        ids: def.get !== undefined,
        query: searchable(tools, type),
        filters: filtersOf(tools, type),
        summary: typeof summary === 'function' ? Object.keys(summary({})) : [...summary],
        fields: fieldsOf(tools, type),
        changedBy: changedBy(tools, type),
      };
    },
  });

  return [read, describe];
}
