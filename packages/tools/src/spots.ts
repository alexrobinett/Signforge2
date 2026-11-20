/**
 * Spot tools: making and editing spot drafts, and what the spot editor's stage needs to preview
 * one. An edit changes the draft only; screens get it at the next publish (./publishing.ts).
 *
 * A template spot's data is checked with the contract's checks for the template (the compiler's
 * `spotProblems`: `validateSpotData`, brand tokens, the duration range), so nothing a screen would
 * refuse is stored. A draft may leave an image field empty until an asset is picked: the publish
 * holds it back until then.
 */
import { spotProblems } from '@signforge/compiler';
import {
  BINDING_PATH,
  missingColumns,
  readPath,
  safeUrl,
  TABLE_ROWS_PATH,
  templateKey,
  validateTableFeed,
  type Binding,
  type FieldDef,
  type TableFeed,
  type TemplateManifest,
} from '@signforge/contract';
import { draftChanged, type OrgScope, type SpotRow } from '@signforge/db';
import { z } from 'zod';
import { draftOutput, id, idempotencyKey, ifVersion, name, orientation, version } from './fields';
import { nextOutput, page, pageInput } from './paging';
import { loadOrg, previewInput } from './publishing';
import { defineTool, notFound, ToolError } from './tool';

const KINDS = ['template', 'image', 'video', 'url'] as const;
const FITS = ['cover', 'contain'] as const;
/** A new image, video or URL spot's length when none is given. */
const DEFAULT_MEDIA_MS = 10_000;

const durationMs = z
  .number()
  .int()
  .min(1000)
  .max(24 * 3600_000)
  .describe('How long the spot stays on screen, in ms');
const data = z
  .record(z.string(), z.unknown())
  .describe("The template's field values by field name: the whole set, replacing the draft's. A field left out takes its default");
const assets = z.record(z.string(), id('asset')).describe("Image fields to verified asset ids, by field name: the whole set, replacing the draft's");
const url = z.string().refine(safeUrl, 'must be an https URL').describe('An https page on another origin');
const column = z.string().min(1).max(200);
const tableMapping = z
  .object({
    columns: z.record(z.string(), column).describe('Item property to the column that fills it, such as { "name": "Item", "price": "Price" }'),
    filter: z
      .object({ column, equals: z.string().max(200) })
      .optional()
      .describe('Only rows whose cell in column is equals, ignoring case'),
    sort: z.object({ column, descending: z.boolean().optional() }).optional().describe("Rows in the order of a column; absent, the file's order"),
  })
  .describe(
    `A list field filled from a csv or json-table source's rows (path ${TABLE_ROWS_PATH}): each row an item, at most the field's maxItems. Properties left out take their defaults`,
  );
const binding = z.object({
  dataSourceId: id('data source'),
  path: z
    .string()
    .max(200)
    .regex(BINDING_PATH, 'must be a dot path such as current.temperature_2m')
    .describe(`A dot path into the source's snapshot; numbers index arrays: daily.temperature_2m_max.0, items. With table, ${TABLE_ROWS_PATH}`),
  table: tableMapping.optional(),
});
const bindings = z
  .record(z.string(), binding)
  .describe(
    "Template fields that take their value from one of the organization's data sources, by field name: the whole set, replacing the draft's ({} unbinds every field). The field's value in data stays as the fallback a screen shows without fresh data. A template's manifest says which fields are live (live.fields) and their usual paths",
  );

/** The fields that belong to one kind of spot (KIND_FIELDS), as create_spot and update_spot both take them. */
const kindInput = {
  data: data.optional(),
  assets: assets.optional(),
  bindings: bindings.optional(),
  assetId: id('asset').optional(),
  fit: z.enum(FITS).optional(),
  url: url.optional(),
};

const spotOutput = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(KINDS),
  durationMs: z.number(),
  templateVersionId: z.string().nullable().describe('Template spots: the template version it plays'),
  data: z.record(z.string(), z.unknown()).nullable().describe('Template spots: field values by field name'),
  assets: z.record(z.string(), z.string()).nullable().describe('Template spots: image fields to asset ids'),
  bindings: z
    .record(z.string(), z.object({ dataSourceId: z.string(), path: z.string(), table: tableMapping.optional() }))
    .nullable()
    .describe('Template spots: fields bound to a data source, as update_spot takes them'),
  assetId: z.string().nullable().describe('Image and video spots'),
  fit: z.enum(FITS).nullable().describe('Image and video spots'),
  url: z.string().nullable().describe('URL spots'),
  version: version.describe('Moves on with every edit of the draft; pass it as ifVersion to update only what you read'),
  ...draftOutput,
});
export type SpotView = z.infer<typeof spotOutput>;
const spotResult = z.object({ spot: spotOutput });

/** A JSON column as the repository stored it. */
function parsed<T>(text: string | null): T | null {
  if (text == null) return null;
  const value: T = JSON.parse(text);
  return value;
}

/** Bindings as tools take them, from the contract's `Binding`s stored on the row. */
function bindingsView(json: string | null): SpotView['bindings'] {
  const stored = parsed<Record<string, Binding>>(json);
  return (
    stored &&
    Object.fromEntries(Object.entries(stored).map(([field, b]) => [field, { dataSourceId: b.source, path: b.path, ...(b.table ? { table: b.table } : {}) }]))
  );
}

const spotView = (row: SpotRow): SpotView => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  durationMs: row.durationMs,
  templateVersionId: row.templateVersionId,
  data: parsed(row.dataJson),
  assets: parsed(row.assetMapJson),
  bindings: bindingsView(row.bindingsJson),
  assetId: row.assetId,
  fit: row.fit,
  url: row.url,
  version: row.rowVersion,
  published: row.publishedJson != null,
  draftChanged: draftChanged(row),
  publishedAt: row.publishedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

async function requireSpot(org: OrgScope, spotId: string) {
  const row = await org.spots.get(spotId);
  if (!row) throw notFound('spot', spotId);
  return row;
}

async function requireVersion(org: OrgScope, templateVersionId: string) {
  const v = await org.templates.versions.get(templateVersionId);
  if (!v) throw notFound('template version', templateVersionId);
  // Registering checked it (register_template_version).
  const manifest: TemplateManifest = JSON.parse(v.manifestJson);
  return { key: templateKey(manifest, v.orgId ?? 'base'), manifest, html: v.bundleSha256 };
}

const invalid = (path: string, problems: string[]) =>
  new ToolError(
    'invalid_input',
    problems.join('; '),
    problems.map((message) => ({ path, message })),
  );

/**
 * Refuses a template draft a screen would refuse. Image fields with no asset yet are left out of
 * the check, and every other field must pass, so a new spot can be saved before its photo is picked.
 */
function checkTemplateDraft(
  t: { key: string; manifest: TemplateManifest; html: string },
  draft: { durationMs: number; data: Record<string, unknown>; assets: Record<string, string>; bindings: Record<string, Binding> },
) {
  const fields: Record<string, FieldDef> = Object.fromEntries(
    Object.entries(t.manifest.fields).filter(([name, def]) => def.type !== 'image' || name in draft.assets || name in draft.bindings),
  );
  for (const name of Object.keys(draft.assets))
    if (t.manifest.fields[name]?.type !== 'image') throw invalid('assets', [`"${name}" is not an image field of ${t.key}`]);
  const problems = spotProblems(
    {
      id: 'draft',
      name: 'draft',
      kind: 'template',
      template: t.key,
      durationMs: draft.durationMs,
      data: draft.data,
      assets: draft.assets,
      bindings: draft.bindings,
    },
    { [t.key]: { manifest: { ...t.manifest, fields }, html: t.html } },
  );
  const range = problems.filter((p) => p.startsWith('duration'));
  if (range.length) throw invalid('durationMs', range);
  const bound = problems.filter((p) => p.startsWith('binding') || p.endsWith('cannot be bound to live data'));
  if (bound.length) throw invalid('bindings', bound);
  if (problems.length) throw invalid('data', problems);
}

/**
 * What a news (`rss`), calendar (`ical`) or table (`csv`, `json-table`) source's snapshot holds,
 * one row of each list: the server converts those feeds to the contract's `NewsFeed`,
 * `CalendarFeed` and `TableFeed`, so a path the shape lacks never finds a value. A JSON source's
 * shape is its feed's, unknown until it is polled.
 */
const TABLE_SHAPE = { what: 'a table', shape: { columns: [''], rows: [['']] } };
const FEED_SHAPES = {
  rss: { what: 'a news feed', shape: { title: '', language: '', items: [{ title: '', published: '', source: '' }] } },
  ical: { what: 'a calendar feed', shape: { events: [{ title: '', start: '', end: '', allDay: false, location: '' }] } },
  csv: TABLE_SHAPE,
  'json-table': TABLE_SHAPE,
} as const;
const isFeedShaped = (format: string | undefined): format is keyof typeof FEED_SHAPES => format !== undefined && Object.hasOwn(FEED_SHAPES, format);

/** The columns of a table source's latest snapshot; undefined before its first poll. */
async function columnsOf(org: OrgScope, dataSourceId: string): Promise<string[] | undefined> {
  const [snap] = await org.dataSources.snapshots([dataSourceId]);
  if (!snap) return undefined;
  const table: TableFeed = JSON.parse(snap.dataJson);
  return validateTableFeed(table).length ? undefined : table.columns;
}

/** Whether `path` reaches a value in `shape`, whose lists hold one row: any index reads that row. */
const reaches = (shape: unknown, path: string) => readPath(shape, path.replace(/(^|\.)\d+(?=\.|$)/g, '$10')) !== undefined;

/**
 * The input's bindings as the contract's, each source one of the org's (`not_found` otherwise)
 * and each path one its feed's shape has. A table binding's source must be a table, and once it
 * has been read, have every column the mapping names. Undefined when the input has none.
 */
async function bindingsOf(org: OrgScope, input: z.infer<typeof bindings> | undefined): Promise<Record<string, Binding> | undefined> {
  if (!input) return undefined;
  const ids = [...new Set(Object.values(input).map((b) => b.dataSourceId))];
  const sources = new Map((await Promise.all(ids.map((i) => org.dataSources.get(i)))).flatMap((d) => (d ? [[d.id, d] as const] : [])));
  const missing = ids.find((i) => !sources.has(i));
  if (missing) throw notFound('data source', missing);
  const problems: string[] = [];
  for (const [field, { dataSourceId, path, table }] of Object.entries(input)) {
    const format = sources.get(dataSourceId)?.format;
    const feed = isFeedShaped(format) ? FEED_SHAPES[format] : undefined;
    if (table) {
      if (feed !== TABLE_SHAPE)
        problems.push(`binding for "${field}": ${dataSourceId} is ${feed?.what ?? `a ${format} source`}, not a table (csv or json-table)`);
      else {
        const columns = await columnsOf(org, dataSourceId);
        const missing = columns ? missingColumns(columns, table) : [];
        if (missing.length)
          problems.push(`binding for "${field}": ${dataSourceId} has no column ${missing.map((c) => `"${c}"`).join(', ')} (it has ${columns?.join(', ')})`);
      }
    } else if (feed && !reaches(feed.shape, path))
      problems.push(`${dataSourceId} is ${feed.what}, which has no ${path} (it has ${Object.keys(feed.shape).join(', ')})`);
  }
  if (problems.length) throw invalid('bindings', problems);
  return Object.fromEntries(
    Object.entries(input).map(([field, b]) => [field, { source: b.dataSourceId, path: b.path, ...(b.table ? { table: b.table } : {}) }]),
  );
}

/** Bindings for the row: none is stored as no bindings at all. */
const bindingsJson = (b: Record<string, Binding>) => (Object.keys(b).length ? JSON.stringify(b) : null);

/** Fields that belong to one kind of spot only. */
const KIND_FIELDS = { template: ['data', 'assets', 'bindings'], image: ['assetId', 'fit'], video: ['assetId', 'fit'], url: ['url'] } as const;

function refuseOtherKinds(kind: SpotRow['kind'], input: Record<string, unknown>) {
  const mine = new Set<string>(KIND_FIELDS[kind]);
  const wrong = Object.values(KIND_FIELDS)
    .flat()
    .filter((f) => input[f] !== undefined && !mine.has(f));
  if (wrong.length)
    throw new ToolError(
      'invalid_input',
      `a ${kind} spot has no ${wrong.join(' or ')}`,
      wrong.map((path) => ({ path, message: `not a field of a ${kind} spot` })),
    );
}

/** An image or video spot's asset must be a verified asset of that kind. */
async function checkMedia(org: OrgScope, kind: 'image' | 'video', assetId: string) {
  const a = await org.assets.get(assetId);
  if (!a) throw notFound('asset', assetId);
  if (a.kind !== kind || a.status !== 'verified') throw invalid('assetId', [`asset ${assetId} is not a verified ${kind}`]);
}

const listSpots = defineTool({
  name: 'list_spots',
  description:
    "List the organization's spots, the drafts as last edited, most recently edited first, a page at a time. Each says whether it is published and whether its draft differs. Returns { spots: Spot[], next }; pass next as cursor for the following page.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ ...pageInput }),
  output: z.object({ spots: z.array(spotOutput), next: nextOutput }),
  example: {},
  handler: async ({ org, input }) => {
    const { rows, next } = page(await org.spots.list(), (s) => [-s.updatedAt, s.id], input);
    return { spots: rows.map(spotView), next };
  },
});

const getSpot = defineTool({
  name: 'get_spot',
  description: "Get one spot's draft. Returns { spot }; pass its version as ifVersion to update_spot.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ spotId: id('spot') }),
  output: spotResult,
  example: { spotId: 'spt_example' },
  handler: async ({ org, input }) => ({ spot: spotView(await requireSpot(org, input.spotId)) }),
});

const createSpot = defineTool({
  name: 'create_spot',
  description:
    "Create a spot as a draft. kind template: a templateVersionId (an approved version from list_templates), with optional data and assets (image fields to asset ids); fields left out take their defaults, and the data must pass the template's checks. kind image or video: an assetId and a fit. kind url: an https url. durationMs defaults to the template's default, or 10 s. Nothing reaches a screen until it is published. Pass an idempotencyKey so a retry cannot create it twice. Returns { spot }.",
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  idempotent: true,
  input: z.object({
    name: name('spot'),
    kind: z.enum(KINDS),
    durationMs: durationMs.optional(),
    templateVersionId: id('template version').optional(),
    ...kindInput,
    idempotencyKey,
  }),
  output: spotResult,
  example: { name: 'Fresh picked', kind: 'template', templateVersionId: 'tpv_example', data: { title: 'Fresh picked' } },
  target: (_input, output) => ({ kind: 'spot', id: output.spot.id }),
  handler: async ({ org, input, write }) => {
    refuseOtherKinds(input.kind, input);
    if (input.kind === 'template') {
      if (!input.templateVersionId) throw invalid('templateVersionId', ['a template spot needs a templateVersionId']);
      const t = await requireVersion(org, input.templateVersionId);
      const bound = (await bindingsOf(org, input.bindings)) ?? {};
      const draft = { durationMs: input.durationMs ?? t.manifest.duration.defaultMs, data: input.data ?? {}, assets: input.assets ?? {}, bindings: bound };
      checkTemplateDraft(t, draft);
      const row = write(
        await org.spots.stage.insert({
          name: input.name,
          kind: 'template',
          durationMs: draft.durationMs,
          templateVersionId: input.templateVersionId,
          dataJson: JSON.stringify(draft.data),
          assetMapJson: JSON.stringify(draft.assets),
          bindingsJson: bindingsJson(bound),
        }),
      );
      return { spot: spotView(row) };
    }
    if (input.templateVersionId) throw invalid('templateVersionId', [`a ${input.kind} spot has no template`]);
    const durationMs = input.durationMs ?? DEFAULT_MEDIA_MS;
    if (input.kind === 'url') {
      if (!input.url) throw invalid('url', ['a url spot needs a url']);
      return { spot: spotView(write(await org.spots.stage.insert({ name: input.name, kind: 'url', durationMs, url: input.url }))) };
    }
    if (!input.assetId) throw invalid('assetId', [`a ${input.kind} spot needs an assetId`]);
    await checkMedia(org, input.kind, input.assetId);
    return {
      spot: spotView(
        write(await org.spots.stage.insert({ name: input.name, kind: input.kind, durationMs, assetId: input.assetId, fit: input.fit ?? 'cover' })),
      ),
    };
  },
});

const updateSpot = defineTool({
  name: 'update_spot',
  description:
    "Change a spot's draft. Give only what changes: name, durationMs; for a template spot data and assets (each the whole set, replacing the draft's); for an image or video spot assetId and fit; for a URL spot url. Template data must pass the template's checks. Screens keep the published version until the next publish. Pass the version you read as ifVersion so a change made since is not overwritten. Returns { spot }.",
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  input: z.object({
    spotId: id('spot'),
    name: name('spot').optional(),
    durationMs: durationMs.optional(),
    ...kindInput,
    ifVersion,
  }),
  output: spotResult,
  example: { spotId: 'spt_example', name: 'Fresh picked', durationMs: 12_000 },
  target: (input) => ({ kind: 'spot', id: input.spotId }),
  handler: async ({ org, input, write }) => {
    const row = await requireSpot(org, input.spotId);
    refuseOtherKinds(row.kind, input);
    const bound = await bindingsOf(org, input.bindings);
    if (row.kind === 'template' && row.templateVersionId) {
      const t = await requireVersion(org, row.templateVersionId);
      checkTemplateDraft(t, {
        durationMs: input.durationMs ?? row.durationMs,
        data: input.data ?? parsed(row.dataJson) ?? {},
        assets: input.assets ?? parsed(row.assetMapJson) ?? {},
        bindings: bound ?? parsed(row.bindingsJson) ?? {},
      });
    }
    if ((row.kind === 'image' || row.kind === 'video') && input.assetId) await checkMedia(org, row.kind, input.assetId);
    const patch = {
      name: input.name,
      durationMs: input.durationMs,
      dataJson: input.data && JSON.stringify(input.data),
      assetMapJson: input.assets && JSON.stringify(input.assets),
      bindingsJson: bound && bindingsJson(bound),
      assetId: input.assetId,
      fit: input.fit,
      url: input.url,
    };
    return { spot: spotView(write(await org.spots.stage.update(row, patch, input.ifVersion))) };
  },
});

const getSpotPreview = defineTool({
  name: 'get_spot_preview',
  description:
    "What a spot editor compiles a draft against to preview it on the real player, for one orientation: the template version's manifest and bundle, a brand kit as screens would get it (brandKitId, else the organization's default), and the data sources. Add the screen and the spot and compile with @signforge/compiler. A kit that cannot be built (an unverified logo) is left out and its problems listed. Returns { preview, brandKitId, problems }.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ orientation, templateVersionId: id('template version').optional(), brandKitId: id('brand kit').optional() }),
  output: z.object({
    preview: z
      .looseObject({
        templates: z.record(z.string(), z.unknown()),
        files: z.record(z.string(), z.object({ size: z.number(), type: z.string() })),
        dataSources: z.array(z.unknown()),
      })
      .describe("A compiler input without its screen and content: templates, files, dataSources and brand (the chosen kit as the screen's)"),
    brandKitId: z.string().nullable().describe('The kit the preview wears, or null for none'),
    problems: z.array(z.string()),
  }),
  example: { orientation: 'landscape', templateVersionId: 'tpv_example', brandKitId: 'bk_example' },
  handler: async ({ org, input }) => {
    if (input.templateVersionId) await requireVersion(org, input.templateVersionId);
    if (input.brandKitId && !(await org.brandKits.get(input.brandKitId))) throw notFound('brand kit', input.brandKitId);
    const { input: preview, brandKitId, problems } = previewInput(await loadOrg(org), input.orientation, input);
    return { preview, brandKitId, problems };
  },
});

export const spotTools = [listSpots, getSpot, createSpot, updateSpot, getSpotPreview];
