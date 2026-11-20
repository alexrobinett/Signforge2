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
import { id, idempotencyKey, ifVersion, name, version } from './fields';
import { nextOutput, page, pageInput } from './paging';
import { defineTool, type FeedUrlSealer, notFound, type PlaceFinder, type TableReader, ToolError } from './tool';

/** Per org (docs/backend-plan.md, Data sources, Limits). */
const MAX_DATA_SOURCES = 10;
const MIN_REFRESH_S = 300;
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
const TABLE_FORMATS = ['csv', 'json-table'] as const;
const format = z
  .enum(['json', 'ical', 'rss', ...TABLE_FORMATS, 'provider'])
  .describe(
    "json passes through; ical becomes a CalendarFeed, rss (RSS 2.0 or Atom) a NewsFeed, csv (with a header row) and json-table (a list of objects) a TableFeed; provider reads a resource through a connection, shaped by the connection's provider",
  );
const rowsPath = z
  .string()
  .max(200)
  .regex(BINDING_PATH, 'must be a dot path such as data.items')
  .describe('json-table only: the dot path to the list of objects, such as data.items. Absent: the document is the list');
const ROWS_PATH_ONLY_JSON_TABLE = 'rowsPath is for json-table sources only';
const resource = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .describe('Provider sources only: what to read at the provider, such as a calendar id or a sheet range. Stored encrypted and never shown again');
const PROVIDER_FIELDS = 'a provider source takes connectionId and resource, and no feedUrl; any other format takes feedUrl only';

/** What a new source reads: a provider source a resource through its connection, a feed its URL; refused if it is given the other's fields. */
function locatorOf(v: { format: string; feedUrl?: string; connectionId?: string; resource?: string }): string {
  const locator = v.format === 'provider' ? !v.feedUrl && v.connectionId && v.resource : !v.connectionId && !v.resource && v.feedUrl;
  if (!locator) throw new ToolError('invalid_input', PROVIDER_FIELDS);
  return locator;
}

const dataSourceOutput = z.object({
  id: z.string(),
  name: z.string(),
  format,
  connectionId: z.string().nullable().describe('A provider source: the connection it reads through'),
  refreshS: z.number(),
  horizonDays: z.number().nullable(),
  rowsPath: z.string().nullable().describe('A json-table source: the path to its list of objects; null for the whole document'),
  nextPollAt: z.number(),
  failures: z.number().describe('Polls in a row that failed; the poller backs off, up to 6 hours'),
  lastError: z
    .string()
    .nullable()
    .describe('Why the last poll failed, as a category (timeout, http-status, private-address, ...; for a provider source needs-reconnect or disconnected)'),
  version: version.describe('Moves on when the source is changed (not with polls); pass it as ifVersion to update only what you read'),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const dataSourceResult = z.object({ dataSource: dataSourceOutput });

const viewOf = (d: DataSourceRow): z.infer<typeof dataSourceOutput> => ({
  id: d.id,
  name: d.name,
  format: d.format,
  connectionId: d.connectionId,
  refreshS: d.refreshS,
  horizonDays: d.horizonDays,
  rowsPath: d.rowsPath,
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

function sealerOf(feedUrls: FeedUrlSealer | undefined): FeedUrlSealer {
  if (!feedUrls) throw new Error('the data source tools need a feed URL sealer');
  return feedUrls;
}

function finderOf(places: PlaceFinder | undefined): PlaceFinder {
  if (!places) throw new Error('find_places needs a place finder');
  return places;
}

function readerOf(tables: TableReader | undefined): TableReader {
  if (!tables) throw new Error('read_table needs a table reader');
  return tables;
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
const HORIZON_ONLY_ICAL = 'horizonDays is for ical sources only';

const target = (input: { dataSourceId: string }) => ({ kind: 'data_source', id: input.dataSourceId });

const listedSourceOutput = dataSourceOutput.extend({
  lastCheckedAt: z.number().nullable().describe('When a poll last found the feed still saying it: its last good check'),
  spots: z.array(z.object({ id: z.string(), name: z.string() })).describe('The spots that bind it, as drafted or as published'),
});

const listDataSources = defineTool({
  name: 'list_data_sources',
  description:
    "List the organization's data sources (feeds that spots can bind to), ordered by id, a page at a time, each with its last good check and the spots that bind it. Returns { dataSources, next }.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ ...pageInput }),
  output: z.object({ dataSources: z.array(listedSourceOutput), next: nextOutput }),
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

const snapshotOutput = z
  .object({ id: z.string(), version: z.number(), fetchedAt: z.string(), checkedAt: z.string(), data: z.unknown() })
  .describe('The latest snapshot, as screens get it; null until a poll succeeds');

const getDataSource = defineTool({
  name: 'get_data_source',
  description:
    "Get a data source and its latest snapshot, which is what a spot bound to it shows (the editor's preview posts it). Returns { dataSource, snapshot }.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ dataSourceId: id('data source') }),
  output: z.object({ dataSource: dataSourceOutput, snapshot: snapshotOutput.nullable() }),
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

const createDataSource = defineTool({
  name: 'create_data_source',
  description: `Add a feed the server polls for spots to bind to. At most ${MAX_DATA_SOURCES} per organization. The first poll runs within a minute. Pass an idempotencyKey so a retry cannot add it twice. Returns { dataSource }.`,
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  idempotent: true,
  input: z
    .object({
      id: id('data source').optional().describe('The id spots bind with, such as weather; made for you if absent'),
      name: name('data source'),
      format,
      feedUrl: feedUrl.optional().describe('Feeds: the URL, https, on the default port, naming a public host. Stored encrypted and never shown again'),
      connectionId: id('connection').optional().describe('Provider sources only: the connection to read through'),
      resource: resource.optional(),
      refreshS: refreshS.default(MIN_REFRESH_S),
      horizonDays: horizonDays.optional(),
      rowsPath: rowsPath.optional(),
      idempotencyKey,
    })
    .refine((v) => calendarOnly(v.format, v.horizonDays), { message: HORIZON_ONLY_ICAL, path: ['horizonDays'] })
    .refine((v) => jsonTableOnly(v.format, v.rowsPath), { message: ROWS_PATH_ONLY_JSON_TABLE, path: ['rowsPath'] }),
  output: dataSourceResult,
  example: {
    id: 'weather',
    name: 'Weather, Atlanta',
    format: 'json',
    feedUrl: 'https://api.open-meteo.com/v1/forecast?latitude=33.75&longitude=-84.39&current=temperature_2m',
  },
  target: (_input, output) => ({ kind: 'data_source', id: output.dataSource.id }),
  handler: async ({ org, input, write, feedUrls }) => {
    const existing = await org.dataSources.list();
    if (existing.length >= MAX_DATA_SOURCES) throw new ToolError('conflict', `an organization has at most ${MAX_DATA_SOURCES} data sources`);
    if (input.id && existing.some((d) => d.id === input.id)) throw new ToolError('conflict', `data source ${input.id} exists`);
    // The URL (or resource) is sealed to the row's id, so the id is chosen first.
    const sourceId = input.id ?? newId('src');
    const urlEncrypted = await sealerOf(feedUrls).seal({ orgId: org.orgId, id: sourceId }, locatorOf(input));
    const row = write(
      await org.dataSources.stage.insert({
        id: sourceId,
        name: input.name,
        format: input.format,
        urlEncrypted,
        connectionId: input.connectionId ?? null,
        refreshS: input.refreshS,
        horizonDays: input.horizonDays ?? null,
        rowsPath: input.rowsPath ?? null,
      }),
    );
    return { dataSource: viewOf(row) };
  },
});

const updateDataSource = defineTool({
  name: 'update_data_source',
  description:
    "Change a data source: its name, feed URL (a provider source: its resource), refresh, calendar look-ahead or a json-table's rows path (null clears either). A new URL or resource is polled afresh within a minute. Only what is given changes. Pass the version you read as ifVersion so a change made since is not overwritten. Returns { dataSource }.",
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  input: z.object({
    dataSourceId: id('data source'),
    name: name('data source').optional(),
    feedUrl: feedUrl.optional(),
    resource: resource.optional(),
    refreshS: refreshS.optional(),
    horizonDays: horizonDays.nullable().optional(),
    rowsPath: rowsPath.nullable().optional(),
    ifVersion,
  }),
  output: dataSourceResult,
  example: { dataSourceId: 'weather', refreshS: 600 },
  target,
  handler: async ({ org, input, write, feedUrls }) => {
    const row = await requireSource(org, input.dataSourceId);
    if (!calendarOnly(row.format, input.horizonDays)) throw new ToolError('invalid_input', HORIZON_ONLY_ICAL);
    if (!jsonTableOnly(row.format, input.rowsPath)) throw new ToolError('invalid_input', ROWS_PATH_ONLY_JSON_TABLE);
    if ((row.format === 'provider' && input.feedUrl) || (row.format !== 'provider' && input.resource)) throw new ToolError('invalid_input', PROVIDER_FIELDS);
    // A new feed, or new rows in it, starts clean: the old one's validators and failures say nothing about it.
    const locator = input.feedUrl ?? input.resource;
    const clean = { etag: null, lastModified: null, failures: 0, lastError: null, nextPollAt: 0 };
    const fresh = {
      ...(locator ? { urlEncrypted: await sealerOf(feedUrls).seal({ orgId: org.orgId, id: row.id }, locator), ...clean } : {}),
      ...(input.rowsPath !== undefined ? clean : {}),
    };
    const updated = write(
      await org.dataSources.stage.update(
        row,
        { name: input.name, refreshS: input.refreshS, horizonDays: input.horizonDays, rowsPath: input.rowsPath, ...fresh },
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

/** Spots whose draft or published version binds a field to `dataSourceId`. */
async function spotsBinding(org: OrgScope, dataSourceId: string): Promise<string[]> {
  return (await org.spots.list())
    .filter((s) => sourcesBound(s.bindingsJson).includes(dataSourceId) || sourcesBound(published(s)?.bindingsJson).includes(dataSourceId))
    .map((s) => s.id);
}

const deleteDataSource = defineTool({
  name: 'delete_data_source',
  description:
    'Delete a data source and its snapshot. Refused with a conflict while a spot, as drafted or as published, binds to it; unbind those spots first. Returns { deleted: dataSourceId }.',
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  input: z.object({ dataSourceId: id('data source') }),
  output: z.object({ deleted: z.string().describe("The deleted data source's id") }),
  example: { dataSourceId: 'weather' },
  target,
  handler: async ({ org, input, write }) => {
    await requireSource(org, input.dataSourceId);
    const spotIds = await spotsBinding(org, input.dataSourceId);
    if (spotIds.length) throw new ToolError('conflict', `data source ${input.dataSourceId} is bound by ${spotIds.length} spots`, { spotIds });
    write(org.dataSources.stage.delete(input.dataSourceId));
    return { deleted: input.dataSourceId };
  },
});

const placeOutput = z.object({
  id: z.number().describe("The geocoder's id for the place"),
  name: z.string(),
  region: z.string().describe("State or province, or ''"),
  country: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  timezone: z.string().describe('IANA time zone'),
});

const findPlaces = defineTool({
  name: 'find_places',
  description:
    "Look places up by name with Open-Meteo's geocoding, best match first, for a weather data source: its forecast URL (https://api.open-meteo.com/v1/forecast) takes the latitude, longitude and timezone. Each search counts against the caller's rate limit; over it, rate_limited. Returns { places }.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ query: z.string().trim().min(2, 'type at least 2 letters of the place').max(100).describe('A place name, such as Atlanta') }),
  output: z.object({ places: z.array(placeOutput) }),
  example: { query: 'Atlanta' },
  handler: async ({ input, places, rateLimit }) => {
    // Unlimited, one member could use up the geocoder's free allowance for every org.
    if (!rateLimit) throw new ToolError('forbidden', 'find_places needs a rate limit, and this caller has none');
    if (!(await rateLimit('place_search'))) throw new ToolError('rate_limited', 'too many place searches; wait a minute and try again');
    return { places: await finderOf(places).search(input.query) };
  },
});

const readTable = defineTool({
  name: 'read_table',
  description:
    "Read a CSV or JSON table at a URL now, as the poller would read it as a csv or json-table source, to see its columns and rows before adding it or mapping its columns onto a list field. Nothing is stored. Each read counts against the caller's rate limit; over it, rate_limited. A file that cannot be read is invalid_input, saying why. Returns { table: { columns, rows } }.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z
    .object({
      feedUrl,
      format: z.enum(TABLE_FORMATS).describe('csv: a header row, then a row per item; json-table: a list of objects'),
      rowsPath: rowsPath.optional(),
    })
    .refine((v) => jsonTableOnly(v.format, v.rowsPath), { message: ROWS_PATH_ONLY_JSON_TABLE, path: ['rowsPath'] }),
  output: z.object({
    table: z
      .object({ columns: z.array(z.string()), rows: z.array(z.array(z.union([z.string(), z.number()]))) })
      .describe('The TableFeed a snapshot would hold'),
  }),
  example: { feedUrl: 'https://example.com/menu.csv', format: 'csv' },
  handler: async ({ input, tables, rateLimit }) => {
    // Unlimited, one member could make the API fetch any URL as fast as it answers.
    if (!rateLimit) throw new ToolError('forbidden', 'read_table needs a rate limit, and this caller has none');
    if (!(await rateLimit('table_read'))) throw new ToolError('rate_limited', 'too many table reads; wait a minute and try again');
    return { table: await readerOf(tables).read({ url: input.feedUrl, format: input.format, rowsPath: input.rowsPath }) };
  },
});

export const dataSourceTools = [listDataSources, getDataSource, createDataSource, updateDataSource, deleteDataSource, findPlaces, readTable];
