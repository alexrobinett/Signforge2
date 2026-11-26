/**
 * `read` and `describe` (#345): one tool an agent reads every type with, and one that says what a type holds. They run
 * today's list and get tools in-process, so a type reads exactly what its tool reads, through the same scoped
 * repositories, with that tool's scope and role checked as the dispatcher checks them: one agent call is one count
 * against its limits and one D1 budget. Today's tools stay in the registry for the CMS and for clients that call them
 * by name; agents are no longer listed them (`READ_TOOLS`).
 */
import { VIDEO_SPEC } from '@signforge/contract';
import { z } from 'zod';
import { effectiveScopes, type Grant, permits } from './dispatch';
import { agentTimeProperties, applyTimes, type TimePlan, timePlan } from './agent-times';
import { outputs } from './outputs';
import { id } from './fields';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from './paging';
import { type AnyTool, defineTool, ToolError, type ToolContext, type ToolServices } from './tool';

type Row = Record<string, unknown>;

/** The H.264 profiles `VIDEO_SPEC.profileIdcs` names, by profile_idc, as describe says them. */
const PROFILE_NAMES: Readonly<Record<number, string>> = { 66: 'Baseline', 77: 'Main', 100: 'High' };

/** How a type is read: its list tool and the key its rows are under, its get tool by id, or one tool that answers whole. */
interface TypeDef {
  about: string;
  list?: { tool: string; items: string };
  /**
   * Its get tool, by id: at most `maxIds` a call, so one call stays within 40 D1 statements (each id costs its get's,
   * measured in apps/api/test/read-cost.test.ts); `rename` moves a get's extra off a row field of the same name; with
   * `latest`, the id `latest` reads the newest (its get's id is optional).
   */
  get?: { tool: string; id: string; item: string; maxIds: number; rename?: Readonly<Record<string, string>>; latest?: true };
  one?: string;
  /** What an agent needs to know of it beyond its fields, which `describe` gives rather than every tool's description (#345). */
  rules?: string;
  /** What `detail: "summary"` (the default) keeps of each row: its fields, or a shape of its own. */
  summary: readonly string[] | ((row: Row) => Row);
}

const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A template's summary: its key and name, and its newest approved version's id, description, orientations and field
 * names, which is what choosing one and filling a spot need. Its versions' whole manifests and check reports are `full`.
 */
/**
 * A publish at summary detail: who made it, when, and how it rolled out, each screen with where it stands on it and its
 * state now, so an agent asking whether it reached its screens needs no full read (#541). full adds each screen's
 * manifest, files missing, wake time and last sync.
 */
function publishSummary(row: Row): Row {
  const pick = ['id', 'revision', 'by', 'createdAt', 'reached', 'screens', 'playing', 'changes'] as const;
  return {
    ...Object.fromEntries(pick.map((k) => [k, row[k]])),
    rollout: Array.isArray(row.rollout)
      ? row.rollout.filter(isRow).map((s) => ({ screenId: s.screenId, name: s.name, outcome: s.outcome, state: s.state }))
      : undefined,
  };
}

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
    get: { tool: 'get_screen', id: 'screenId', item: 'screen', maxIds: 4 },
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
    rules:
      "Nothing reaches a screen until the organization has a default playlist: when it has none, and the regular schedule entries a publish makes live on every screen at all hours all play one playlist, that playlist becomes the default (madeDefault); a takeover or a narrower entry never sets it, so set one with set_default_playlist first, or its screens get nothing (each listed with that problem). A publish removes the deleted schedule entries it covers (all of them, or the pinned ones) and the takeovers that have ended, listed in removed. A pinned draft that needs no promotion is still checked: one changed since fails the publish as a conflict. A spot it would promote that still holds its template's sample text (its sampleFields) refuses the whole publish with sample_text before any screen is compiled, details { spots: [{ id, name, version, fields }] }: replace the text, or a person publishes again with allowSample naming those spots, versions and fields. A screen a publish cannot compile keeps what it plays and is listed with its problems. A publish's rollout gives each screen it switched and where it stands. playing: it says it plays it. downloading: it is fetching the new files (filesMissing). asleep: outside its display hours until wakesAt; it takes it when it wakes. unreachable: not heard from since lastSeenAt; it plays what it has from its cache and takes it when back. An outcome is where the screen stands on this publish; state is the screen's state now, { kind, reason } as read screen_status gives it: a screen playing it may since be unreachable, and one unreachable before it took it reads needs_you, reason behind. waiting: online, and switching now. fell_back: the new manifest played nothing, so it went back to its last good one. revoked: its credential was revoked. replaced: a later publish switched it since.",
    list: { tool: 'list_publishes', items: 'publishes' },
    get: { tool: 'get_publish', id: 'publishId', item: 'publish', maxIds: 7, rename: { screens: 'rollout' }, latest: true },
    summary: publishSummary,
  },
  publish_request: {
    about: 'requests to publish drafts, and their decisions',
    list: { tool: 'list_publish_requests', items: 'requests' },
    get: { tool: 'get_publish_request', id: 'publishRequestId', item: 'request', maxIds: 12 },
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
    get: { tool: 'get_template', id: 'templateId', item: 'template', maxIds: 18 },
    summary: templateSummary,
  },
  asset: {
    about: 'images and videos',
    rules: `An image is uploaded as a landscape and a portrait rendition, each the smallest that covers its screen box (1920x1080, 1080x1920). A video ships as it is exported, with no transcoding: H.264 MP4, profile ${VIDEO_SPEC.profileIdcs.map((p) => PROFILE_NAMES[p] ?? p).join(', ')} up to level ${VIDEO_SPEC.maxLevel / 10}, ${VIDEO_SPEC.bitDepth}-bit 4:2:0, progressive, at most ${VIDEO_SPEC.maxWidth}x${VIDEO_SPEC.maxHeight} either way round, ${VIDEO_SPEC.maxFps} fps, ${VIDEO_SPEC.maxBitrate / 1e6} Mbit/s and ${VIDEO_SPEC.maxBytes / 1e6} MB (@signforge/media-check checks it). An asset is usable once its status is verified.`,
    list: { tool: 'list_assets', items: 'assets' },
    get: { tool: 'get_asset', id: 'assetId', item: 'asset', maxIds: 12 },
    summary: ['id', 'name', 'kind', 'status', 'width', 'height', 'durationMs', 'usageCount'],
  },
  font: { about: 'fonts a brand kit can use', list: { tool: 'list_fonts', items: 'fonts' }, summary: ['id', 'family', 'roles', 'weights', 'available'] },
  brand_kit: {
    about: 'brand kits: colors, fonts, logo, where they apply',
    rules:
      "Leave out onPrimary and onAccent to have them derived for 4.5:1 contrast; pairs below 4.5:1 come back as warnings. The organization's first kit becomes its default. The default kit is the kit of every screen with no choice of its own and none from its groups (assign_brand_kit chooses one). Screens get a kit's change at the next publish; a save's result says which screens it will reach.",
    list: { tool: 'list_brand_kits', items: 'brandKits' },
    get: { tool: 'get_brand_kit', id: 'brandKitId', item: 'brandKit', maxIds: 9 },
    summary: ['id', 'name', 'colors', 'displayFont', 'bodyFont', 'isDefault', 'version'],
  },
  data_source: {
    about: 'live data sources (feeds, tables, weather); full with ids adds the latest snapshot',
    list: { tool: 'list_data_sources', items: 'dataSources' },
    get: { tool: 'get_data_source', id: 'dataSourceId', item: 'dataSource', maxIds: 18 },
    summary: ['id', 'name', 'format', 'refreshS', 'lastError', 'version'],
  },
  spot: {
    about: 'spots: what plays, as drafted; full has their data',
    rules:
      "A template spot's field can be bound to one of the organization's data sources (bindings): it then shows the source's value at its path, and the field's value in data stays as the fallback a screen shows without fresh data. A template's manifest says which fields are live and their usual paths: live.fields for one source, or each named source's fields under live.sources, each source's fields bound to a data source of its kind. A list field can be filled from a csv or json-table source's rows (path rows, with a table mapping of item properties to columns). Nothing reaches a screen until the spot is published.",
    list: { tool: 'list_spots', items: 'spots' },
    get: { tool: 'get_spot', id: 'spotId', item: 'spot', maxIds: 30 },
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
    get: { tool: 'get_playlist', id: 'playlistId', item: 'playlist', maxIds: 12 },
    summary: ['id', 'name', 'spotIds', 'isDefault', 'version', 'published', 'draftChanged'],
  },
  schedule_entry: {
    about: 'schedule entries and takeovers: which playlist plays where and when',
    rules:
      "What a screen plays, from the next publish: of the entries that apply to it now (in its own time zone, within their dates, days and window), the highest priority wins, and a takeover's is above every entry's. On a tie the more specific target wins (screen, then group, then org), then the later startsAt, so of two takeovers aimed alike the newer wins. Where none applies, the organization's default playlist. A published takeover cuts in at once, ending the spot on screen, and ends on time with the network down; once over it is left out of every publish and deleted at the next. A takeover's playlist changed later reaches a screen at the end of the spot on screen.",
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

/** The tools that change each type, as describe names them: explicit, so a tool named alike is never one of them. */
const CHANGED_BY = {
  screen: ['update_screen', 'screen_command', 'revoke_screen_credential', 'update_screen_labels', 'assign_brand_kit'],
  screen_status: ['screen_command', 'revoke_screen_credential'],
  group: ['save_group', 'delete_group'],
  label_key: ['update_screen_labels'],
  publish: ['publish', 'roll_back_publish', 'takeover'],
  publish_request: ['request_publish'],
  draft_count: ['publish'],
  template: ['register_template_version'],
  asset: ['start_upload', 'finalize_upload', 'delete'],
  font: [],
  brand_kit: ['save_brand_kit', 'assign_brand_kit'],
  data_source: ['save_data_source', 'delete'],
  spot: ['save_spot'],
  agent_draft: [],
  playlist: ['save_playlist', 'delete', 'set_default_playlist'],
  schedule_entry: ['save_schedule_entry', 'start_takeover', 'delete', 'takeover'],
  audit_entry: [],
  member: [],
  org: ['update_org_settings'],
  connection: ['disconnect'],
  alert_delivery: [],
  alert_channels: [],
  invitation: ['cancel_invitation'],
} as const satisfies Record<ReadType, readonly string[]>;
const TYPE_NAMES = Object.keys(READ_TYPES).filter((t): t is ReadType => t in READ_TYPES);
const defOf = (type: ReadType): TypeDef => READ_TYPES[type];

export const isReadType = (v: unknown): v is ReadType => typeof v === 'string' && v in READ_TYPES;

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

/**
 * The types `grant` may read: `read` is its to use, every tool the type reads with is too, none is a person's alone,
 * and, when `services` are known, each has the services it needs (a connection's provider).
 */
export const readTypes = (tools: Tools, grant: Grant, services?: ToolServices): ReadType[] => {
  // `read` itself is a viewer's with content:read: without it, nothing.
  if (!effectiveScopes(grant).includes('content:read')) return [];
  return TYPE_NAMES.filter((type) =>
    toolsOf(type).every((name) => {
      const tool = toolNamed(tools, name);
      return permits(grant, tool) && !tool.people && (services === undefined || (tool.needs ?? []).every((n) => services[n] !== undefined));
    }),
  );
};

/** Whether `read` serves registry read `name` for `grant`: if not, the tool is listed as it is (an `org:manage` grant's invitations). */
export const servedByRead = (tools: Tools, grant: Grant, name: string, services?: ToolServices) =>
  readTypes(tools, grant, services).some((type) => toolsOf(type).includes(name));

const typeField = (types: readonly ReadType[]) => z.enum(types).describe('What to read; describe(type) says its filters and fields');

/** `read`'s description for `types`: one line each, so a model picks a type without describing it first. */
export const readDescription = (types: readonly ReadType[]) =>
  [
    "Read anything in the organization. Give its type, and ids to read those, or a filter, to list a page of them; pass next as cursor for the next page. detail is summary by default: the fields most tasks need, with names beside ids; full has every field, and with ids what the type's own page shows (a screen's credentials and events, a data source's snapshot). Read with detail full before you change a thing whole (a spot's data). fields picks fields. A wrong filter or field is refused with the right ones. Types:",
    ...types.map((t) => `${t}: ${defOf(t).about}.`),
    'Returns { type, items, next }.',
  ].join(' ');

/** `read`'s input, its type one of `types`: a key it does not take is refused, saying where it goes. */
export const readInput = (types: readonly ReadType[]) =>
  z.strictObject(
    {
      type: typeField(types),
      ids: z.array(id('record')).min(1).optional().describe("Read these by id, at most as many as describe's maxIds (publish takes 'latest'); omit to list"),
      filter: z.record(z.string(), z.unknown()).optional().describe("The type's filters, as describe lists them; with ids, only its idOptions"),
      query: z.string().min(1).max(100).optional().describe('Words in the name, where the type can search (asset, audit_entry)'),
      detail: z.enum(['summary', 'full']).optional().describe('summary (the default): the fields most tasks need; full: every field'),
      fields: z.array(z.string()).min(1).max(40).optional().describe('Only these top-level fields of each row'),
      // A list's page: the list's own default when omitted, and none with ids.
      limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).optional().describe(`How many to list, 1 to ${MAX_PAGE_LIMIT}; default ${DEFAULT_PAGE_LIMIT}`),
      cursor: z.string().max(2000).optional().describe("The previous page's next, to list the page after it"),
    },
    { error: (issue) => (issue.code === 'unrecognized_keys' ? `read takes no ${issue.keys.join(', ')}: put a type's filters under filter` : undefined) },
  );

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

/** What a get adds to a row, renamed where it shares a name with a row field (a publish's rollout). */
function extrasOf(tools: Tools, type: ReadType): Record<string, unknown> {
  const { get } = defOf(type);
  if (!get) return {};
  const { [get.item]: _row, ...extras } = propertiesOf(tools, get.tool);
  return Object.fromEntries(Object.entries(extras).map(([k, v]) => [get.rename?.[k] ?? k, v]));
}

/** The fields of a type's rows as its list gives them, or, with ids, as its get does, with what the get adds. */
function rowFieldsOf(tools: Tools, type: ReadType, byIds: boolean): Record<string, unknown> {
  const { list, get } = defOf(type);
  if (byIds && get) return { ...propertiesOf(tools, get.tool, get.item), ...extrasOf(tools, type) };
  return list ? propertiesOf(tools, list.tool, list.items) : fieldsOf(tools, type);
}

/** Every field of `type`'s `full` rows as JSON Schema, each time as an agent reads it, ISO 8601 (`agentOutputOf`). */
function fieldsOf(tools: Tools, type: ReadType): Record<string, unknown> {
  return agentTimeProperties(fieldsAsTools(tools, type));
}

/** Every field of `type`'s `full` rows as its own read tools give them: a time as ms since the epoch. */
function fieldsAsTools(tools: Tools, type: ReadType): Record<string, unknown> {
  const def = defOf(type);
  if (type === 'org')
    return {
      id: { type: 'string' },
      name: { type: 'string' },
      role: { type: 'string' },
      scopes: { type: 'array', items: { type: 'string' } },
      settings: { type: 'object', properties: propertiesOf(tools, 'get_org_settings', 'settings') },
      aiProvider: propertiesOf(tools, 'get_ai_provider').provider,
    };
  if (def.one) return propertiesOf(tools, def.one);
  const fromGet = def.get ? { ...propertiesOf(tools, def.get.tool, def.get.item), ...extrasOf(tools, type) } : {};
  return { ...(def.list ? propertiesOf(tools, def.list.tool, def.list.items) : {}), ...fromGet };
}

/** A tool's input fields, as JSON Schema. */
const inputFieldsOf = (tools: Tools, tool: string): Row => {
  const schema: Row = z.toJSONSchema(toolNamed(tools, tool).input, { io: 'input', unrepresentable: 'any' });
  return isRow(schema.properties) ? schema.properties : {};
};

/** A type's filters: its list (or one) tool's input, less paging and what `read` takes itself. */
function filtersOf(tools: Tools, type: ReadType): Row {
  const def = defOf(type);
  const tool = def.list?.tool ?? def.one;
  if (!tool) return {};
  const { limit: _limit, cursor: _cursor, query: _query, ...filters } = inputFieldsOf(tools, tool);
  return filters;
}

/** What a read by ids takes besides them: its get tool's other input (a spot's published version). */
function idOptionsOf(tools: Tools, type: ReadType): Row {
  const { get } = defOf(type);
  if (!get) return {};
  const { [get.id]: _id, ...options } = inputFieldsOf(tools, get.tool);
  return options;
}

const searchable = (tools: Tools, type: ReadType) => {
  const tool = defOf(type).list?.tool;
  return tool !== undefined && 'query' in inputFieldsOf(tools, tool);
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

/** The tools that change `type` and that `grant` may use. */
const changedBy = (tools: Tools, type: ReadType, grant: Grant) =>
  CHANGED_BY[type].filter((name) => {
    const tool = tools.get(name);
    return tool !== undefined && !tool.people && permits(grant, tool);
  });

/**
 * `read` and `describe` over `tools`, the registry's other tools: built by the registry, which holds them too, so neither
 * module imports the other.
 */
export function readTools(tools: Tools) {
  const read = defineTool({
    name: 'read',
    description: readDescription(TYPE_NAMES),
    listedDescription: (grant, services) => readDescription(readTypes(tools, grant, services)),
    scope: 'content:read',
    minRole: 'viewer',
    mutates: false,
    input: readInput(TYPE_NAMES),
    listedInput: (grant, services) => readInput(readTypes(tools, grant, services)),
    output: outputs.read,
    example: { type: 'screen', filter: { selector: { all: [{ key: 'orientation', op: 'eq', values: ['portrait'] }] } } },
    handler: async (ctx) => {
      const { type, ids, filter = {}, query, detail = 'summary', fields, limit, cursor } = ctx.input satisfies ReadInput;
      const def = defOf(type);
      const byIds = ids !== undefined;
      const known = Object.keys(rowFieldsOf(tools, type, byIds));
      const wrong = (fields ?? []).filter((f) => !known.includes(f));
      if (wrong.length) throw teach(`${type} ${byIds ? 'read by ids' : 'listed'} has no field ${wrong.join(', ')}: its fields are ${known.join(', ')}`, type);
      const filters = Object.keys(byIds ? idOptionsOf(tools, type) : filtersOf(tools, type));
      const unknown = Object.keys(filter).filter((k) => !filters.includes(k));
      if (unknown.length) {
        const takes = filters.length ? `it takes ${filters.join(', ')}` : 'it takes none';
        throw teach(`${type}${byIds ? ' read by ids' : ''} has no filter ${unknown.join(', ')}: ${takes}`, type);
      }
      if (query !== undefined && (byIds || !searchable(tools, type)))
        throw teach(
          `${type} cannot be searched by query${byIds ? ' with ids' : ''}: ${TYPE_NAMES.filter((t) => searchable(tools, t)).join(' and ')} can`,
          type,
        );
      if (byIds && !def.get) throw teach(`${type} cannot be read by ids: list it, with a filter`, type);
      if (byIds && (limit !== undefined || cursor !== undefined)) throw teach(`limit and cursor page a list: read ${type} by ids without them`, type);
      if (byIds && def.get && ids.length > def.get.maxIds) throw teach(`at most ${def.get.maxIds} ${type} ids a call: read the rest in another call`, type);

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
      if (byIds && def.get) {
        const { get } = def;
        const rows = [];
        for (const one of ids) {
          const input = one === 'latest' && get.latest ? filter : { ...filter, [get.id]: one };
          const { [get.item]: main, ...extras } = await runRead(ctx, get.tool, input, type);
          // None to read: the newest publish of an org that has never published (`publish: null`).
          if (!isRow(main)) continue;
          const renamed = Object.fromEntries(Object.entries(extras).map(([k, v]) => [get.rename?.[k] ?? k, v]));
          rows.push(shown({ ...main, ...renamed }));
        }
        return { type, items: rows, next: null };
      }
      if (!def.list) throw teach(`${type} cannot be listed`, type);
      const { items: key } = def.list;
      const out = await runRead(
        ctx,
        def.list.tool,
        { ...filter, ...(query === undefined ? {} : { query }), ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) },
        type,
      );
      const { [key]: rows, next, total, ...extra } = out;
      return {
        type,
        items: (Array.isArray(rows) ? rows : []).filter(isRow).map(shown),
        next: typeof next === 'string' ? next : null,
        ...(typeof total === 'number' ? { total } : {}),
        ...(Object.keys(extra).length ? { extra } : {}),
      };
    },
  });

  const describe = defineTool({
    name: 'describe',
    description:
      'What read gives for a type: its rules, filters, whether it reads by ids or searches, the fields of summary and of full, and the tools that change it. Call it once for a type before you filter it or pick its fields. Returns { type, about, rules, ids, query, filters, summary, fields, changedBy }.',
    scope: 'content:read',
    minRole: 'viewer',
    mutates: false,
    input: describeInput(TYPE_NAMES),
    listedInput: (grant, services) => describeInput(readTypes(tools, grant, services)),
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
        rules: def.rules ?? null,
        ids: def.get !== undefined,
        maxIds: def.get?.maxIds ?? 0,
        idOptions: idOptionsOf(tools, type),
        query: searchable(tools, type),
        filters: filtersOf(tools, type),
        summary: typeof summary === 'function' ? Object.keys(summary({})) : [...summary],
        fields: fieldsOf(tools, type),
        changedBy: changedBy(tools, type, grant),
      };
    },
  });

  return [read, describe];
}

/**
 * A tool's output as an agent reads it (#345): each time its output schema declares as ISO 8601 (./agent-times.ts),
 * and `read`'s rows by their type's own fields, as `describe` lists them. Nothing else is touched: no value a schema
 * leaves opaque (a snapshot's data, a spot's data, an audit entry's detail), and no output of a name no tool has.
 */
export function agentOutputOf(tools: Tools) {
  const plans = new Map<string, TimePlan | undefined>();
  const planOf = (key: string, make: () => TimePlan | undefined) => {
    if (!plans.has(key)) plans.set(key, make());
    return plans.get(key);
  };
  return (name: string, input: unknown, output: unknown): unknown => {
    if (name === 'read') {
      const type = typeof input === 'object' && input !== null && 'type' in input ? input.type : undefined;
      if (!isReadType(type)) return output;
      const rows = () => timePlan({ type: 'object', properties: fieldsAsTools(tools, type) });
      return applyTimes(
        planOf(`read/${type}`, () => ({ props: { items: { items: rows() } } })),
        output,
      );
    }
    const tool = tools.get(name);
    if (!tool) return output;
    return applyTimes(
      planOf(name, () => timePlan(z.toJSONSchema(tool.output, { io: 'output', unrepresentable: 'any' }))),
      output,
    );
  };
}
