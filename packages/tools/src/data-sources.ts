/**
 * Data source tools. A data source is a feed the server polls (docs/backend-plan.md, Data
 * sources); spots bind fields to paths in its snapshots. The feed URL can be a secret (a private
 * calendar), so it is sealed before it is stored and never shown again. A provider source reads
 * a resource (a calendar id, a sheet range) through one of the org's connections
 * (./connections.ts) instead of a URL; its resource is sealed the same way. A `csv` or
 * `json-table` source is a table, whose rows a spot maps onto a list field (`read_table` shows
 * one before it is added).
 */
import { BINDING_PATH, type DataSnapshot } from '@signforge/contract';
import { type DataSourceRow, newId, type OrgScope, published } from '@signforge/db';
import { FEED_URL_PROBLEMS, feedUrlProblem } from '@signforge/feeds';
import { z } from 'zod';
import { id, idempotencyKey, ifVersion, name } from './fields';
import { page, pageInput } from './paging';
import { defineTool, invalidFields, notFound, ToolError, type ToolContext } from './tool';
import { type dataSourceOutput, outputs, sourceFormat, TABLE_FORMATS } from './outputs';

/** Per org (docs/backend-plan.md, Data sources, Limits). */
const MAX_DATA_SOURCES = 10;
const MIN_REFRESH_S = 300;
/** A news feed polls hourly unless a person chooses faster (owner decision on #339): stories turn over in hours, and each poll can queue photos. */
const RSS_REFRESH_S = 3600;
const MAX_REFRESH_S = 86_400;

const feedUrl = z
  .string()
  .max(2048)
  .superRefine((url, ctx) => {
    const problem = feedUrlProblem(url);
    if (problem) ctx.addIssue({ code: 'custom', message: FEED_URL_PROBLEMS[problem] });
  })
  .describe('The feed: https, on the default port, naming a public host. Stored encrypted and never shown again');
const refreshS = z
  .number()
  .int()
  .min(MIN_REFRESH_S, `refresh no faster than every ${MIN_REFRESH_S} seconds`)
  .max(MAX_REFRESH_S)
  .describe(`How often to poll the feed, in seconds, ${MIN_REFRESH_S} to ${MAX_REFRESH_S}`);
const horizonDays = z
  .number()
  .int()
  .min(1)
  .max(366)
  .describe('Calendars only: how many days ahead events reach (default 30). A holiday board wants months, a meeting room days');
const rowsPath = z
  .string()
  .max(200)
  .regex(BINDING_PATH, 'must be a dot path such as data.items')
  .describe('json-table only: the dot path to the list of objects, such as data.items. Absent: the document is the list');
const ROWS_PATH_ONLY_JSON_TABLE = 'rowsPath is for json-table sources only';
const photos = z
  .boolean()
  .describe("rss only: whether screens get the stories' photos, which the server fetches, checks and stores (default true). False: headlines only");
const PHOTOS_ONLY_RSS = 'photos is for rss sources only';
const resource = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .describe('Provider sources only: what to read at the provider, such as a calendar id or a sheet range. Stored encrypted and never shown again');
const PROVIDER_FIELDS = 'a provider source takes connectionId and resource, and no feedUrl; any other format takes feedUrl only';

/** What a new source reads: a provider source a resource through its connection, a feed its URL; none if it is given the other's fields. */
const locatorOf = (v: { format: string; feedUrl?: string; connectionId?: string; resource?: string }) =>
  (v.format === 'provider' ? !v.feedUrl && v.connectionId && v.resource : !v.connectionId && !v.resource && v.feedUrl) || undefined;

const viewOf = (d: DataSourceRow): z.infer<typeof dataSourceOutput> => ({
  id: d.id,
  name: d.name,
  format: d.format,
  connectionId: d.connectionId,
  refreshS: d.refreshS,
  horizonDays: d.horizonDays,
  rowsPath: d.rowsPath,
  // An rss source's switch; no other format has photos, whatever an older row stored (#345).
  photos: d.format === 'rss' && d.photos,
  nextPollAt: d.nextPollAt,
  failures: d.failures,
  lastError: d.lastError,
  version: d.rowVersion,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
});

async function requireSource(org: OrgScope, dataSourceId: string) {
  const row = await org.dataSources.get(dataSourceId);
  if (!row) throw notFound('data source', dataSourceId);
  return row;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** The source ids a spot's stored bindings name. */
function sourcesBound(json: string | null | undefined): string[] {
  if (json == null) return [];
  const bindings: unknown = JSON.parse(json);
  if (!isObject(bindings)) return [];
  return Object.values(bindings).flatMap((b) => (isObject(b) && typeof b.source === 'string' ? [b.source] : []));
}

const calendarOnly = (f: string, days: number | null | undefined) => days == null || f === 'ical';
const jsonTableOnly = (f: string, path: string | null | undefined) => path == null || f === 'json-table';
const rssOnly = (f: string, on: boolean | undefined) => on === undefined || f === 'rss';
const HORIZON_ONLY_ICAL = 'horizonDays is for ical sources only';

const listDataSources = defineTool({
  name: 'list_data_sources',
  description:
    "List the organization's data sources (feeds that spots can bind to), ordered by id, a page at a time, each with its last good check and the spots that bind it. Returns { dataSources, next }.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ ...pageInput }),
  output: outputs.list_data_sources,
  example: {},
  handler: async ({ org, input }) => {
    const { rows, next } = page(await org.dataSources.list(), (d) => [d.id], input);
    const [snapshots, spots] = await Promise.all([org.dataSources.checkedTimes(rows.map((d) => d.id)), org.spots.list()]);
    const bound = spots.map((s) => ({
      id: s.id,
      name: s.name,
      sources: new Set([...sourcesBound(s.bindingsJson), ...sourcesBound(published(s)?.bindingsJson)]),
    }));
    return {
      dataSources: rows.map((d) => {
        const snap = snapshots.find((x) => x.dataSourceId === d.id);
        return {
          ...viewOf(d),
          lastCheckedAt: snap?.checkedAt ?? null,
          spots: bound.filter((s) => s.sources.has(d.id)).map(({ id, name }) => ({ id, name })),
        };
      }),
      next,
    };
  },
});

const getDataSource = defineTool({
  name: 'get_data_source',
  description:
    "Get a data source and its latest snapshot, which is what a spot bound to it shows (the editor's preview posts it). Returns { dataSource, snapshot }.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ dataSourceId: id('data source') }),
  output: outputs.get_data_source,
  example: { dataSourceId: 'weather' },
  handler: async ({ org, input }) => {
    const row = await requireSource(org, input.dataSourceId);
    const [snap] = await org.dataSources.snapshots([row.id]);
    const snapshot: DataSnapshot | null = snap
      ? {
          id: row.id,
          version: snap.fetchedAt,
          fetchedAt: new Date(snap.fetchedAt).toISOString(),
          checkedAt: new Date(snap.checkedAt).toISOString(),
          data: JSON.parse(snap.dataJson),
        }
      : null;
    return { dataSource: viewOf(row), snapshot };
  },
});

// Strict, as every save is: a field it does not take is refused by name, not dropped (review of #499).
export const saveDataSourceInput = z.strictObject({
  dataSourceId: id('data source').optional().describe('The source to change; omit to add one'),
  id: id('data source').optional().describe('A new source: the id spots bind with, such as weather; made for you if absent'),
  name: name('data source').optional(),
  format: sourceFormat.optional().describe("A new source's format; fixed once made"),
  feedUrl: feedUrl.optional().describe('Feeds: the URL, https, on the default port, naming a public host. Stored encrypted and never shown again'),
  connectionId: id('connection').optional().describe('A new provider source: the connection to read through'),
  resource: resource.optional(),
  refreshS: refreshS
    .optional()
    .describe(
      `How often to poll the feed, in seconds, ${MIN_REFRESH_S} to ${MAX_REFRESH_S}; for a new source default ${RSS_REFRESH_S} for rss, ${MIN_REFRESH_S} for the rest`,
    ),
  horizonDays: horizonDays.nullable().optional(),
  rowsPath: rowsPath.nullable().optional(),
  photos: photos.optional(),
  ifVersion,
  idempotencyKey,
});

type DataSourceFormat = z.infer<typeof sourceFormat>;

/**
 * Why save_data_source refuses this input, on what it gives alone and, for a change, the source's format: the agent
 * drawer's card asks it too, so it never offers a press that can only be refused (#507).
 */
export function sourceRefusal(input: z.infer<typeof saveDataSourceInput>, current?: DataSourceFormat): ToolError | undefined {
  const created = input.dataSourceId === undefined;
  if (created && input.ifVersion !== undefined) return invalidFields('a new data source has no version yet: ifVersion is for a change', 'ifVersion');
  if (created && (input.name === undefined || input.format === undefined))
    return invalidFields(
      'a new data source needs a name and a format; give dataSourceId to change one',
      ...(['name', 'format'] as const).filter((k) => input[k] === undefined),
    );
  const fixed = created ? [] : (['id', 'format', 'connectionId'] as const).filter((k) => input[k] !== undefined);
  if (fixed.length)
    return invalidFields(`a data source's ${fixed.join(', ')} ${fixed.length > 1 ? 'are' : 'is'} fixed once made: add another source for another`, ...fixed);
  const format = input.format ?? current;
  if (format === undefined) return undefined;
  if (!calendarOnly(format, input.horizonDays)) return invalidFields(HORIZON_ONLY_ICAL, 'horizonDays');
  if (!jsonTableOnly(format, input.rowsPath)) return invalidFields(ROWS_PATH_ONLY_JSON_TABLE, 'rowsPath');
  if (!rssOnly(format, input.photos)) return invalidFields(PHOTOS_ONLY_RSS, 'photos');
  const wrongLocator = created
    ? !locatorOf({ ...input, format })
    : (format === 'provider' && input.feedUrl !== undefined) || (format !== 'provider' && input.resource !== undefined);
  if (wrongLocator) return invalidFields(PROVIDER_FIELDS, ...(['feedUrl', 'connectionId', 'resource'] as const).filter((k) => input[k] !== undefined));
  return undefined;
}

const saveDataSource = defineTool({
  name: 'save_data_source',
  description: `Add a feed the server polls for spots to bind to, or change one. Without dataSourceId it adds one: a name, a format, and a feedUrl (a provider source: a connectionId and its resource); at most ${MAX_DATA_SOURCES} per organization. The first poll runs within a minute; it polls every refreshS seconds after, by default every ${RSS_REFRESH_S} for rss and ${MIN_REFRESH_S} for the rest. Pass an idempotencyKey so a retry cannot add it twice. With dataSourceId it changes what you give: its name, feed URL (a provider source: its resource), refresh, calendar look-ahead, a json-table's rows path (null clears either) or whether a news feed's photos are shown; a new URL or resource is polled afresh within a minute. A source's format and connection are fixed once made. Pass the version you read as ifVersion so a change made since is not overwritten. Returns { dataSource }.`,
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  idempotent: true,
  needs: ['feedUrls'],
  input: saveDataSourceInput,
  output: outputs.save_data_source,
  example: {
    id: 'weather',
    name: 'Weather, Atlanta',
    format: 'json',
    feedUrl: 'https://api.open-meteo.com/v1/forecast?latitude=33.75&longitude=-84.39&current=temperature_2m',
  },
  // Behind the drawer's card, a refused press has no output (`refusedPress`): no target then, for a new source.
  target: (input, output: { dataSource: { id: string } } | undefined) => {
    const sourceId = input.dataSourceId ?? output?.dataSource.id;
    return sourceId === undefined ? undefined : { kind: 'data_source', id: sourceId };
  },
  handler: async ({ org, input, write, publishRight, services: { feedUrls } }) => {
    const { dataSourceId } = input;
    if (dataSourceId === undefined) {
      const refused = sourceRefusal(input);
      if (refused) throw refused;
      // Given, and a locator with them: sourceRefusal refuses a new source otherwise.
      const name = input.name!;
      const format = input.format!;
      // A provider source reads whatever its resource names through a person's connection, and get_data_source shows what it
      // read: it is added only with the right to publish, by a person or an agent (#122; for people too, owner decision on #424).
      if (format === 'provider')
        publishRight("Reading a new resource through a person's connection needs the right to publish: ask someone who may publish to add it");
      const existing = await org.dataSources.list();
      if (existing.length >= MAX_DATA_SOURCES) throw new ToolError('conflict', `an organization has at most ${MAX_DATA_SOURCES} data sources`);
      if (input.id && existing.some((d) => d.id === input.id)) throw new ToolError('conflict', `data source ${input.id} exists`);
      // The URL (or resource) is sealed to the row's id, so the id is chosen first.
      const sourceId = input.id ?? newId('src');
      const urlEncrypted = await feedUrls.seal({ orgId: org.orgId, id: sourceId }, locatorOf({ ...input, format })!);
      const row = write(
        await org.dataSources.stage.insert({
          id: sourceId,
          name,
          format,
          urlEncrypted,
          connectionId: input.connectionId ?? null,
          refreshS: input.refreshS ?? (format === 'rss' ? RSS_REFRESH_S : MIN_REFRESH_S),
          horizonDays: input.horizonDays ?? null,
          rowsPath: input.rowsPath ?? null,
          photos: format === 'rss' && (input.photos ?? true),
        }),
      );
      return { dataSource: viewOf(row) };
    }
    const fixed = sourceRefusal(input);
    if (fixed) throw fixed;
    const row = await requireSource(org, dataSourceId);
    // The poller takes a source's change to screens with no publish, whatever spot shows it now or later (one published
    // meanwhile, a rolled-back screen still syncing it): anything but its name changes only with the right to publish, held
    // to the commit, for an agent (#122, reviews of #419) and a person alike (owner decision on #424). A name reaches no screen.
    if (reachesScreens(input))
      publishRight('Changing a data source needs the right to publish: screens follow its changes with no publish. Its name alone may change');
    const refused = sourceRefusal(input, row.format);
    if (refused) throw refused;
    // A new feed, or new rows in it, starts clean: the old one's validators and failures say nothing about it.
    // Feed photos' own read-afresh rule (packages/db `feed-photos.ts`) resets the rest when `photos` or the URL changes.
    const locator = input.feedUrl ?? input.resource;
    const clean = { etag: null, lastModified: null, failures: 0, lastError: null, nextPollAt: 0 };
    const fresh = {
      ...(locator ? { urlEncrypted: await feedUrls.seal({ orgId: org.orgId, id: row.id }, locator), ...clean } : {}),
      ...(input.rowsPath !== undefined ? clean : {}),
    };
    const updated = write(
      await org.dataSources.stage.update(
        row,
        { name: input.name, refreshS: input.refreshS, horizonDays: input.horizonDays, rowsPath: input.rowsPath, photos: input.photos, ...fresh },
        input.ifVersion,
      ),
    );
    return { dataSource: viewOf(updated) };
  },
});

/**
 * Whether the CMS's spot editor made this source from a place and units (`weatherSource` in
 * apps/cms/src/lib/live-data.ts, whose `madeByEditor` this must match: apps/cms/test/registry/
 * editor-sources.test.ts). The editor deletes one when a save stops binding it, but not while a
 * published version still does; a publish deletes it once nothing binds it (./publish.ts). A feed
 * or calendar added by its address is a person's to delete.
 */
export const madeBySpotEditor = (dataSourceId: string) => /^weather-\d+-[cf]-(?:mph|kmh)-[0-9a-f]{6}$/.test(dataSourceId);

/** Whether a change changes more than a source's name: anything else, a field added later included, reaches screens. */
export const reachesScreens = (input: Record<string, unknown>) =>
  Object.entries(input).some(([k, v]) => v !== undefined && !['dataSourceId', 'name', 'ifVersion', 'idempotencyKey'].includes(k));

/** Spots whose draft or published version binds a field to `dataSourceId`. */
async function spotsBinding(org: OrgScope, dataSourceId: string): Promise<string[]> {
  return (await org.spots.list())
    .filter((s) => sourcesBound(s.bindingsJson).includes(dataSourceId) || sourcesBound(published(s)?.bindingsJson).includes(dataSourceId))
    .map((s) => s.id);
}

/** Delete a data source and its snapshot (the `delete` tool, ./delete.ts): refused with a conflict while a spot, drafted or published, binds it. */
export async function deleteDataSource({ org, write }: Pick<ToolContext<unknown>, 'org' | 'write'>, dataSourceId: string) {
  await requireSource(org, dataSourceId);
  const spotIds = await spotsBinding(org, dataSourceId);
  if (spotIds.length) throw new ToolError('conflict', `data source ${dataSourceId} is bound by ${spotIds.length} spots`, { spotIds });
  write(org.dataSources.stage.delete(dataSourceId));
}

const findPlaces = defineTool({
  name: 'find_places',
  description:
    "Look places up by name with Open-Meteo's geocoding, best match first, for a weather data source: its forecast URL (https://api.open-meteo.com/v1/forecast) takes the latitude, longitude and timezone. Each search counts against the caller's rate limit; over it, rate_limited. Returns { places }.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  // Unlimited, one member could use up the geocoder's free allowance for every org.
  needs: ['rateLimit', 'places'],
  input: z.object({ query: z.string().trim().min(2, 'type at least 2 letters of the place').max(100).describe('A place name, such as Atlanta') }),
  output: outputs.find_places,
  example: { query: 'Atlanta' },
  handler: async ({ input, services: { places, rateLimit } }) => {
    if (!(await rateLimit('place_search'))) throw new ToolError('rate_limited', 'too many place searches; wait a minute and try again');
    return { places: await places.search(input.query) };
  },
});

const readTable = defineTool({
  name: 'read_table',
  description:
    "Read a CSV or JSON table at a URL now, as the poller would read it as a csv or json-table source, to see its columns and rows before adding it or mapping its columns onto a list field. Nothing is stored. Each read counts against the caller's rate limit; over it, rate_limited. A file that cannot be read is invalid_input, saying why. Returns { table: { columns, rows } }.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  // Unlimited, one member could make the API fetch any URL as fast as it answers.
  needs: ['rateLimit', 'tables'],
  input: z
    .object({
      feedUrl,
      format: z.enum(TABLE_FORMATS).describe('csv: a header row, then a row per item; json-table: a list of objects'),
      rowsPath: rowsPath.optional(),
    })
    .refine((v) => jsonTableOnly(v.format, v.rowsPath), { message: ROWS_PATH_ONLY_JSON_TABLE, path: ['rowsPath'] }),
  output: outputs.read_table,
  example: { feedUrl: 'https://example.com/menu.csv', format: 'csv' },
  handler: async ({ input, services: { tables, rateLimit } }) => {
    if (!(await rateLimit('table_read'))) throw new ToolError('rate_limited', 'too many table reads; wait a minute and try again');
    return { table: await tables.read({ url: input.feedUrl, format: input.format, rowsPath: input.rowsPath }) };
  },
});

export const dataSourceTools = [listDataSources, getDataSource, saveDataSource, findPlaces, readTable];
