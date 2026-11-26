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
import { bindingOf, DEFAULT_FIT, draftCheck, sampleAfterEdit, sampleData, sampleFieldsOf, unverified } from '@signforge/compiler/draft';
import {
  BINDING_PATH,
  missingColumns,
  readPath,
  safeUrl,
  TABLE_ROWS_PATH,
  templateKey,
  validateTableFeed,
  type Binding,
  type SampleFields,
  type TableFeed,
  type TemplateManifest,
} from '@signforge/contract';
import { contentJson, draftChanged, published, StaleVersionError, type OrgScope, type SpotRow } from '@signforge/db';
import { z } from 'zod';
import { DECIDING, decidedMeanwhile, keptFor, shownVersion, spotContent } from './agent-drafts';
import { id, idempotencyKey, ifVersion, name, orientation } from './fields';
import { page, pageInput } from './paging';
import { loadOrg, previewInput, spotDraft } from './publishing';
import { defineTool, isAgent, notFound, ToolError } from './tool';
import { outputs, SPOT_FITS, SPOT_KINDS, tableMapping, type SpotView } from './outputs';

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
    "Template fields that take their value from one of the organization's data sources, by field name: the whole set, replacing the draft's ({} unbinds every field). The field's value in data stays as the fallback a screen shows without fresh data. A template's manifest says which fields are live and their usual paths: live.fields for one source, or each named source's fields under live.sources, each source's fields bound to a data source of its kind",
  );

/** The fields that belong to one kind of spot (KIND_FIELDS), as save_spot takes them. */
const kindInput = {
  data: data.optional(),
  assets: assets.optional(),
  bindings: bindings.optional(),
  assetId: id('asset').optional(),
  fit: z.enum(SPOT_FITS).optional(),
  url: url.optional(),
};

/** A JSON column as the repository stored it. */
function parsed<T>(text: string | null): T | null {
  if (text == null) return null;
  const value: T = JSON.parse(text);
  return value;
}

const spotView = (row: SpotRow): SpotView => ({
  ...spotDraft(row),
  sampleFields: parsed<SampleFields>(row.sampleFieldsJson),
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
 * Refuses a template draft a screen would refuse, but for what a draft may leave without a value
 * for now (`draftCheck`: an image with no asset, a date not picked), so a new spot can be saved
 * before its photo or its day is picked.
 */
function checkTemplateDraft(
  t: { key: string; manifest: TemplateManifest; html: string },
  draft: { durationMs: number; data: Record<string, unknown>; assets: Record<string, string>; bindings: Record<string, Binding> },
) {
  const checked = draftCheck(t.manifest.fields, draft);
  for (const name of Object.keys(draft.assets))
    if (t.manifest.fields[name]?.type !== 'image') throw invalid('assets', [`"${name}" is not an image field of ${t.key}`]);
  const problems = spotProblems(
    {
      id: 'draft',
      name: 'draft',
      kind: 'template',
      template: t.key,
      durationMs: draft.durationMs,
      data: checked.data,
      assets: draft.assets,
      bindings: draft.bindings,
    },
    { [t.key]: { manifest: { ...t.manifest, fields: checked.fields }, html: t.html } },
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
  ical: { what: 'a calendar feed', shape: { events: [{ title: '', start: '', end: '', allDay: false, location: '', organizer: '' }] } },
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
  return Object.fromEntries(Object.entries(input).map(([field, b]) => [field, bindingOf(b)]));
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
  const problem = a.kind !== kind ? `asset ${assetId} is not a ${kind}` : unverified(assetId, a.status);
  if (problem) throw invalid('assetId', [problem]);
}

const listSpots = defineTool({
  name: 'list_spots',
  description:
    "List the organization's spots, the drafts as last edited, most recently edited first, a page at a time. Each says whether it is published and whether its draft differs. Filter by kind, or to the unpublished ones. Returns { spots: Spot[], next, total }: total counts every spot the filters match; pass next as cursor for the following page.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({
    ...pageInput,
    kind: z.enum(SPOT_KINDS).optional().describe('Only spots of this kind'),
    unpublished: z.boolean().optional().describe('Only those whose draft differs from what is published (never published included)'),
  }),
  output: outputs.list_spots,
  example: {},
  handler: async ({ org, input }) => {
    const views = (await org.spots.list()).map(spotView).filter((s) => (!input.kind || s.kind === input.kind) && (!input.unpublished || s.draftChanged));
    const { rows, next } = page(views, (s) => [-s.updatedAt, s.id], input);
    return { spots: rows, next, total: views.length };
  },
});

const getSpot = defineTool({
  name: 'get_spot',
  description:
    "Get one spot's draft. Returns { spot }; pass its version as ifVersion to save_spot. published: true gets the version screens have instead, shaped as the draft, its version the one published: not_found if it was never published.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ spotId: id('spot'), published: z.boolean().optional().describe("The version screens have, not the draft's") }),
  output: outputs.get_spot,
  example: { spotId: 'spt_example' },
  handler: async ({ org, input }) => {
    const row = await requireSpot(org, input.spotId);
    if (!input.published) return { spot: spotView(row) };
    // What the approvals queue plays beside the draft (#115).
    const live = published(row);
    if (!live || row.publishedVersion === null) throw notFound('published spot', input.spotId);
    return { spot: { ...spotView(live), version: row.publishedVersion } };
  },
});

const saveSpot = defineTool({
  name: 'save_spot',
  description:
    "Create a spot as a draft, or change one's draft. Without spotId it creates one: a name and a kind. kind template: a templateVersionId (an approved version from read), with optional data and assets (image fields to asset ids); fields left out take their defaults, and the data must pass the template's checks. kind image or video: an assetId and a fit. kind url: an https url. durationMs defaults to the template's default, or 10 s. Pass an idempotencyKey so a retry cannot create it twice. With spotId it changes what you give: name, durationMs; for a template spot data and assets (each the whole set, replacing the draft's); for an image or video spot assetId and fit; for a URL spot url. A spot's kind and template are fixed once made. Pass the version you read as ifVersion so a change made since is not overwritten. Nothing reaches a screen until it is published. Returns { spot }.",
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  idempotent: true,
  partialAgents: "an agent's edit is its proposal (#116), held to the version it read",
  input: z.object({
    spotId: id('spot').optional().describe('The spot to change; omit to create one'),
    name: name('spot').optional(),
    kind: z.enum(SPOT_KINDS).optional().describe("A new spot's kind; fixed once made"),
    durationMs: durationMs.optional(),
    templateVersionId: id('template version').optional().describe("A new template spot's template version; fixed once made"),
    ...kindInput,
    sample: z
      .boolean()
      .optional()
      .describe(
        "A new template spot: start the texts and lists with the template's sample copy (its defaults; live fields stay empty), in place of data, and record them as sampleFields until each is edited. publish refuses the spot while any is left, unless a person allows it",
      ),
    ifVersion,
    idempotencyKey,
  }),
  output: outputs.save_spot,
  example: { name: 'Fresh picked', kind: 'template', templateVersionId: 'tpv_example', data: { title: 'Fresh picked' } },
  // Behind the drawer's card, a refused press has no output (`refusedPress`): no target then, for a new spot.
  target: (input, output: { spot: { id: string } } | undefined) => {
    const spotId = input.spotId ?? output?.spot.id;
    return spotId === undefined ? undefined : { kind: 'spot', id: spotId };
  },
  handler: async ({ org, actor, input, write }) => {
    const { spotId, name, kind } = input;
    if (spotId === undefined) {
      if (name === undefined || kind === undefined) throw invalid(name === undefined ? 'name' : 'kind', ['a new spot needs a name and a kind; give spotId to change one']);
      refuseOtherKinds(kind, input);
      if (kind === 'template') {
        if (!input.templateVersionId) throw invalid('templateVersionId', ['a template spot needs a templateVersionId']);
        const t = await requireVersion(org, input.templateVersionId);
        const bound = (await bindingsOf(org, input.bindings)) ?? {};
        if (input.sample && input.data) throw invalid('data', ['a spot started with its sample copy takes no data']);
        const startData = input.sample ? sampleData(t.manifest) : (input.data ?? {});
        const draft = { durationMs: input.durationMs ?? t.manifest.duration.defaultMs, data: startData, assets: input.assets ?? {}, bindings: bound };
        checkTemplateDraft(t, draft);
        // A field bound to a source shows the source, not its sample: it is not marked.
        const sample = input.sample ? sampleFieldsOf(t.manifest, Object.fromEntries(Object.entries(startData).filter(([f]) => !(f in bound)))) : null;
        const row = write(
          await org.spots.stage.insert({
            name,
            kind: 'template',
            durationMs: draft.durationMs,
            templateVersionId: input.templateVersionId,
            dataJson: JSON.stringify(draft.data),
            assetMapJson: JSON.stringify(draft.assets),
            bindingsJson: bindingsJson(bound),
            sampleFieldsJson: sample && JSON.stringify(sample),
          }),
        );
        return { spot: spotView(row) };
      }
      if (input.templateVersionId) throw invalid('templateVersionId', [`a ${kind} spot has no template`]);
      const durationMs = input.durationMs ?? DEFAULT_MEDIA_MS;
      if (kind === 'url') {
        if (!input.url) throw invalid('url', ['a url spot needs a url']);
        return { spot: spotView(write(await org.spots.stage.insert({ name, kind: 'url', durationMs, url: input.url }))) };
      }
      if (!input.assetId) throw invalid('assetId', [`a ${kind} spot needs an assetId`]);
      await checkMedia(org, kind, input.assetId);
      return {
        spot: spotView(
          write(await org.spots.stage.insert({ name, kind, durationMs, assetId: input.assetId, fit: input.fit ?? DEFAULT_FIT })),
        ),
      };
    }
    for (const fixed of ['kind', 'templateVersionId', 'sample'] as const)
      if (input[fixed] !== undefined) throw invalid(fixed, [`a spot's ${fixed} is fixed once made: create another spot for another`]);
    // An edit that changes nothing writes nothing to guard it, so it is refused, as save_playlist's is (review of #410).
    if (![name, input.durationMs, input.data, input.assets, input.bindings, input.assetId, input.fit, input.url].some((x) => x !== undefined))
      throw invalid('spotId', ['nothing to change']);
    const row = await requireSpot(org, spotId);
    refuseOtherKinds(row.kind, input);
    const bound = await bindingsOf(org, input.bindings);
    const t = row.kind === 'template' && row.templateVersionId ? await requireVersion(org, row.templateVersionId) : null;
    if (t) {
      checkTemplateDraft(t, {
        durationMs: input.durationMs ?? row.durationMs,
        data: input.data ?? parsed(row.dataJson) ?? {},
        assets: input.assets ?? parsed(row.assetMapJson) ?? {},
        bindings: bound ?? parsed(row.bindingsJson) ?? {},
      });
    }
    if ((row.kind === 'image' || row.kind === 'video') && input.assetId) await checkMedia(org, row.kind, input.assetId);
    // A sample field this edit changes, or binds, is the person's now (#360).
    const sample = parsed<SampleFields>(row.sampleFieldsJson);
    const left =
      sample &&
      sampleAfterEdit(
        sample,
        t?.manifest.fields ?? {},
        { data: parsed(row.dataJson) ?? {} },
        { data: input.data ?? parsed(row.dataJson) ?? {}, bindings: bound ?? parsed(row.bindingsJson) ?? {} },
      );
    const patch = {
      name: input.name,
      durationMs: input.durationMs,
      dataJson: input.data && JSON.stringify(input.data),
      assetMapJson: input.assets && JSON.stringify(input.assets),
      bindingsJson: bound && bindingsJson(bound),
      assetId: input.assetId,
      fit: input.fit,
      url: input.url,
      ...(sample && { sampleFieldsJson: left && JSON.stringify(left) }),
    };
    // An agent's edit is its proposal (#116): the draft it replaces is kept beside it, so it is held to the version read.
    write(await keptFor(org, actor, 'spot', row));
    return { spot: spotView(write(await org.spots.stage.update(row, patch, input.ifVersion ?? (isAgent(actor) ? row.rowVersion : undefined)))) };
  },
});

/** The spot at the version shown, or refused as changed since. */
async function spotAt(org: OrgScope, spotId: string, version: number) {
  const row = await requireSpot(org, spotId);
  if (row.rowVersion !== version) throw new StaleVersionError(row.id, row.rowVersion);
  return row;
}

/** Reject's and Keep's input: the spot, at the version shown. */
const decideSpotInput = z.object({ spotId: id('spot'), ifVersion: shownVersion });

const revertSpotDraft = defineTool({
  name: 'revert_spot_draft',
  description:
    "Reject an agent's draft of a spot (#116): the draft goes back to the one the agent wrote over (the person's, or as published), with its sample-text marks, and the agent's is kept beside it; the same call again puts the agent's back (its Undo). Refused with a conflict if neither is kept (no agent's draft to reject), and if the spot changed since ifVersion. People only. Returns { spot, rejected }.",
  ...DECIDING,
  input: decideSpotInput,
  output: outputs.revert_spot_draft,
  example: { spotId: 'spt_example', ifVersion: 3 },
  target: (input) => ({ kind: 'spot', id: input.spotId }),
  handler: async ({ org, input, write }) => {
    const row = await spotAt(org, input.spotId, input.ifVersion);
    const kept = await org.draftSnapshots.get('spot', row.id);
    if (!kept) throw new ToolError('conflict', `spot ${row.id} has no agent's draft to reject`, { kept: null });
    const back = spotContent.parse(JSON.parse(kept.contentJson));
    // The two swap: the draft there now is kept beside the one put back.
    const rejected = kept.holds === 'person';
    // Still kept as read when the batch runs: a Keep, Reject or publish committed first refuses this one.
    write(org.draftSnapshots.stage.holding('spot', row.id, kept.holds));
    write(
      org.draftSnapshots.stage.keep('spot', row, rejected ? 'agent' : 'person', {
        contentJson: contentJson(row),
        sampleFieldsJson: row.sampleFieldsJson,
      }),
    );
    const spot = write(await org.spots.stage.update(row, { ...back, sampleFieldsJson: kept.sampleFieldsJson }, input.ifVersion));
    return { spot: spotView(spot), rejected };
  },
  refuseFailedCommit: ({ org, input }) => decidedMeanwhile(org, 'spot', input.spotId, input.ifVersion),
});

const keepSpotDraft = defineTool({
  name: 'keep_spot_draft',
  description:
    "Keep an agent's draft of a spot as the draft (#116): it is no longer a proposal, and the draft it was written over is let go. The draft is not changed and not published. Refused with a conflict if it is not an agent's proposal, or the spot changed since ifVersion. People only. Returns { spot }.",
  ...DECIDING,
  input: decideSpotInput,
  output: outputs.keep_spot_draft,
  example: { spotId: 'spt_example', ifVersion: 3 },
  target: (input) => ({ kind: 'spot', id: input.spotId }),
  handler: async ({ org, input, write }) => {
    const row = await spotAt(org, input.spotId, input.ifVersion);
    if ((await org.draftSnapshots.get('spot', row.id))?.holds !== 'person') throw new ToolError('conflict', `spot ${row.id} is not an agent's proposal`);
    // Held to the version shown, and to the agent's proposal, in the batch too: an edit, a Reject, a Keep or a publish landing first refuses it.
    write(org.spots.stage.unchanged(row));
    write(org.draftSnapshots.stage.holding('spot', row.id, 'person'));
    write(org.draftSnapshots.stage.clear('spot', row.id));
    return { spot: spotView(row) };
  },
  refuseFailedCommit: ({ org, input }) => decidedMeanwhile(org, 'spot', input.spotId, input.ifVersion),
});

const getSpotPreview = defineTool({
  name: 'get_spot_preview',
  description:
    "What a spot editor compiles a draft against to preview it on the real player, for one orientation: the template version's manifest and bundle, a brand kit as screens would get it (brandKitId, else the organization's default), and the data sources, plus the organization's time zone for new screens. Compile the draft on @signforge/compiler's probe screen (compileProbe), as a publish checks it. A kit that cannot be built (an unverified logo) is left out and its problems listed. Returns { preview, brandKitId, problems, timezone }.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ orientation, templateVersionId: id('template version').optional(), brandKitId: id('brand kit').optional() }),
  output: outputs.get_spot_preview,
  example: { orientation: 'landscape', templateVersionId: 'tpv_example', brandKitId: 'bk_example' },
  handler: async ({ org, input }) => {
    if (input.templateVersionId) await requireVersion(org, input.templateVersionId);
    if (input.brandKitId && !(await org.brandKits.get(input.brandKitId))) throw notFound('brand kit', input.brandKitId);
    const graph = await loadOrg(org);
    const { input: preview, brandKitId, problems } = previewInput(graph, input.orientation, input);
    return { preview, brandKitId, problems, timezone: graph.timezone };
  },
});

/** Refused while a playlist plays the spot, in its draft or its published version, which screens may have: listed, to change first. */
async function inUse(org: OrgScope, spotId: string): Promise<ToolError | undefined> {
  const playlists = (await org.spots.usedBy(spotId)).map((p) => ({ id: p.id, name: p.name }));
  if (!playlists.length) return undefined;
  const names = playlists.map((p) => `"${p.name}"`).join(', ');
  return new ToolError(
    'conflict',
    `spot ${spotId} is in ${playlists.length === 1 ? 'a playlist' : `${playlists.length} playlists`}: ${names}; take it out of them first`,
    {
      playlists,
    },
  );
}

const deleteSpot = defineTool({
  name: 'delete_spot',
  description:
    'Delete a spot, its draft and its published version. Refused with a conflict while a playlist plays it, in its draft or its published version (details.playlists, each { id, name }): take it out of those first, and publish them if screens play them. Its assets and data sources are not deleted. Pass the version you read as ifVersion so a spot changed since is not deleted. Only a person may delete one: no agent is offered it. Returns { deleted: spotId }.',
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  // #242: deleting is a person's choice, as its confirmation in the spot editor says; no ticket gives it to an agent.
  people: true,
  input: z.object({ spotId: id('spot'), ifVersion }),
  output: outputs.delete_spot,
  example: { spotId: 'spt_example' },
  target: (input) => ({ kind: 'spot', id: input.spotId }),
  handler: async ({ org, input, write }) => {
    const row = await requireSpot(org, input.spotId);
    if (input.ifVersion !== undefined && row.rowVersion !== input.ifVersion) throw new StaleVersionError(row.id, row.rowVersion);
    const used = await inUse(org, input.spotId);
    if (used) throw used;
    // At a version: guarded in the batch, as an edit is, so one saved between this read and the commit refuses it too.
    write(input.ifVersion === undefined ? org.spots.stage.delete(input.spotId) : org.spots.stage.remove(row));
    return { deleted: input.spotId };
  },
  // A playlist that took the spot in since fails the delete's foreign key: said as the same conflict.
  refuseFailedCommit: async ({ org, input }) => inUse(org, input.spotId),
});

export const spotTools = [listSpots, getSpot, saveSpot, revertSpotDraft, keepSpotDraft, deleteSpot, getSpotPreview];
