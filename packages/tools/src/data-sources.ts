/**
 * Data source tools. A data source is a feed the server polls (docs/backend-plan.md, Data
 * sources); spots bind fields to paths in its snapshots. The feed URL can be a secret (a private
 * calendar), so it is sealed before it is stored and never shown again. A provider source reads
 * a resource (a calendar id, a sheet range) through one of the org's connections
 * (./connections.ts) instead of a URL; its resource is sealed the same way. A `csv` or
 * `json-table` source is a table, whose rows a spot maps onto a list field (`read_table` shows
 * one before it is added).
 */
import type { DataSnapshot } from '@signforge/contract';
import { type DataSourceRow, newId, type OrgScope, published } from '@signforge/db';
import { staleAge } from '@signforge/player-core';
import type { z } from 'zod';
import { page } from './paging';
import { defineTool, invalidFields, notFound, ToolError, type ToolContext } from './tool';
import { type dataSourceOutput, outputs, type sourceFormat } from './outputs';
import { inputs, jsonTableOnly, MIN_REFRESH_S, ROWS_PATH_ONLY_JSON_TABLE, RSS_REFRESH_S, type saveDataSourceInput } from './inputs';

/** Per org (docs/backend-plan.md, Data sources, Limits). */
const MAX_DATA_SOURCES = 10;

const PHOTOS_ONLY_RSS = 'photos is for rss sources only';
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
  // 0 is the poller's "due now", not a time (#543).
  nextPollAt: d.nextPollAt === 0 ? null : d.nextPollAt,
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
const rssOnly = (f: string, on: boolean | undefined) => on === undefined || f === 'rss';
const HORIZON_ONLY_ICAL = 'horizonDays is for ical sources only';

const listDataSources = defineTool({
  name: 'list_data_sources',
  description:
    "List the organization's data sources (feeds that spots can bind to), ordered by id, a page at a time, each with its last good check and the spots that bind it. Returns { dataSources, next }.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: inputs.list_data_sources,
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
  input: inputs.get_data_source,
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
          ...staleAge(snap),
          data: JSON.parse(snap.dataJson),
        }
      : null;
    return { dataSource: viewOf(row), snapshot };
  },
});

type DataSourceFormat = z.infer<typeof sourceFormat>;

/** Why a source of `format` refuses fields only another format takes. */
function formatRefusal(input: z.infer<typeof saveDataSourceInput>, format: DataSourceFormat): ToolError | undefined {
  if (!calendarOnly(format, input.horizonDays)) return invalidFields(HORIZON_ONLY_ICAL, 'horizonDays');
  if (!jsonTableOnly(format, input.rowsPath)) return invalidFields(ROWS_PATH_ONLY_JSON_TABLE, 'rowsPath');
  if (!rssOnly(format, input.photos)) return invalidFields(PHOTOS_ONLY_RSS, 'photos');
  return undefined;
}

/** The fields a new source of `format` gets wrong for what it reads: those missing for it, and those of the other kind given. */
const locatorPaths = (input: z.infer<typeof saveDataSourceInput>, format: DataSourceFormat) =>
  format === 'provider'
    ? [...(input.feedUrl !== undefined ? ['feedUrl'] : []), ...(['connectionId', 'resource'] as const).filter((k) => input[k] === undefined)]
    : [...(input.feedUrl === undefined ? ['feedUrl'] : []), ...(['connectionId', 'resource'] as const).filter((k) => input[k] !== undefined)];

/** A new source as save_data_source adds it, its name, format and what it reads; or why not. */
function newSourceOf(input: z.infer<typeof saveDataSourceInput>): { refused: ToolError } | { name: string; format: DataSourceFormat; locator: string } {
  if (input.ifVersion !== undefined) return { refused: invalidFields('a new data source has no version yet: ifVersion is for a change', 'ifVersion') };
  const { name, format } = input;
  if (name === undefined || format === undefined)
    return {
      refused: invalidFields(
        'a new data source needs a name and a format; give dataSourceId to change one',
        ...(['name', 'format'] as const).filter((k) => input[k] === undefined),
      ),
    };
  const refused = formatRefusal(input, format);
  if (refused) return { refused };
  const locator = locatorOf({ ...input, format });
  if (!locator) return { refused: invalidFields(PROVIDER_FIELDS, ...locatorPaths(input, format)) };
  return { name, format, locator };
}

/**
 * Why save_data_source refuses this input, on what it gives alone and, for a change, the source's format: the agent
 * drawer's card asks it too, so it never offers a press that can only be refused (#507).
 */
export function sourceRefusal(input: z.infer<typeof saveDataSourceInput>, current?: DataSourceFormat): ToolError | undefined {
  if (input.dataSourceId === undefined) {
    const made = newSourceOf(input);
    return 'refused' in made ? made.refused : undefined;
  }
  const fixed = (['id', 'format', 'connectionId'] as const).filter((k) => input[k] !== undefined);
  if (fixed.length)
    return invalidFields(`a data source's ${fixed.join(', ')} ${fixed.length > 1 ? 'are' : 'is'} fixed once made: add another source for another`, ...fixed);
  if (current === undefined) return undefined;
  const refused = formatRefusal(input, current);
  if (refused) return refused;
  if (current === 'provider' && input.feedUrl !== undefined) return invalidFields(PROVIDER_FIELDS, 'feedUrl');
  if (current !== 'provider' && input.resource !== undefined) return invalidFields(PROVIDER_FIELDS, 'resource');
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
  input: inputs.save_data_source,
  output: outputs.save_data_source,
  example: {
    id: 'weather',
    name: 'Weather, Atlanta',
    format: 'json',
    feedUrl: 'https://api.open-meteo.com/v1/forecast?latitude=33.75&longitude=-84.39&current=temperature_2m',
  },
  target: (input, output) => {
    const sourceId = input.dataSourceId ?? output?.dataSource.id;
    return sourceId === undefined ? undefined : { kind: 'data_source', id: sourceId };
  },
  handler: async ({ org, input, write, publishRight, services: { feedUrls } }) => {
    const { dataSourceId } = input;
    if (dataSourceId === undefined) {
      const made = newSourceOf(input);
      if ('refused' in made) throw made.refused;
      const { name, format, locator } = made;
      // A provider source reads whatever its resource names through a person's connection, and get_data_source shows what it
      // read: it is added only with the right to publish, by a person or an agent (#122; for people too, owner decision on #424).
      if (format === 'provider')
        publishRight("Reading a new resource through a person's connection needs the right to publish: ask someone who may publish to add it");
      const existing = await org.dataSources.list();
      if (existing.length >= MAX_DATA_SOURCES)
        throw new ToolError('conflict', `an organization has at most ${MAX_DATA_SOURCES} data sources`, { max: MAX_DATA_SOURCES });
      if (input.id && existing.some((d) => d.id === input.id)) throw new ToolError('conflict', `data source ${input.id} exists`);
      // The URL (or resource) is sealed to the row's id, so the id is chosen first.
      const sourceId = input.id ?? newId('src');
      const urlEncrypted = await feedUrls.seal({ orgId: org.orgId, id: sourceId }, locator);
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
  input: inputs.find_places,
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
  input: inputs.read_table,
  output: outputs.read_table,
  example: { feedUrl: 'https://example.com/menu.csv', format: 'csv' },
  handler: async ({ input, services: { tables, rateLimit } }) => {
    if (!(await rateLimit('table_read'))) throw new ToolError('rate_limited', 'too many table reads; wait a minute and try again');
    return { table: await tables.read({ url: input.feedUrl, format: input.format, rowsPath: input.rowsPath }) };
  },
});

export const dataSourceTools = [listDataSources, getDataSource, saveDataSource, findPlaces, readTable];
