/**
 * Data source tools. A data source is a feed the server polls (docs/backend-plan.md, Data
 * sources); spots bind fields to paths in its snapshots. The feed URL can be a secret (a private
 * calendar), so it is sealed before it is stored and never shown again.
 */
import type { DataSnapshot } from '@signforge/contract';
import { type DataSourceRow, newId, type OrgScope, published } from '@signforge/db';
import { FEED_URL_PROBLEMS, feedUrlProblem } from '@signforge/feeds';
import { z } from 'zod';
import { id, idempotencyKey, name } from './fields';
import { nextOutput, page, pageInput } from './paging';
import { defineTool, type FeedUrlSealer, notFound, ToolError } from './tool';

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
const format = z.enum(['json', 'ical', 'rss']).describe('json passes through; ical becomes a CalendarFeed, rss (RSS 2.0 or Atom) a NewsFeed');

const dataSourceOutput = z.object({
  id: z.string(),
  name: z.string(),
  format,
  refreshS: z.number(),
  horizonDays: z.number().nullable(),
  nextPollAt: z.number(),
  failures: z.number().describe('Polls in a row that failed; the poller backs off, up to 6 hours'),
  lastError: z.string().nullable().describe('Why the last poll failed, as a category (timeout, http-status, private-address, ...)'),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const dataSourceResult = z.object({ dataSource: dataSourceOutput });

const viewOf = (d: DataSourceRow): z.infer<typeof dataSourceOutput> => ({
  id: d.id,
  name: d.name,
  format: d.format,
  refreshS: d.refreshS,
  horizonDays: d.horizonDays,
  nextPollAt: d.nextPollAt,
  failures: d.failures,
  lastError: d.lastError,
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

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const calendarOnly = (f: string, days: number | null | undefined) => days == null || f === 'ical';
const HORIZON_ONLY_ICAL = 'horizonDays is for ical sources only';

const target = (input: { dataSourceId: string }) => ({ kind: 'data_source', id: input.dataSourceId });

const listDataSources = defineTool({
  name: 'list_data_sources',
  description: "List the organization's data sources (feeds that spots can bind to), ordered by id, a page at a time. Returns { dataSources, next }.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ ...pageInput }),
  output: z.object({ dataSources: z.array(dataSourceOutput), next: nextOutput }),
  example: {},
  handler: async ({ org, input }) => {
    const { rows, next } = page(await org.dataSources.list(), (d) => [d.id], input);
    return { dataSources: rows.map(viewOf), next };
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
      feedUrl,
      refreshS: refreshS.default(MIN_REFRESH_S),
      horizonDays: horizonDays.optional(),
      idempotencyKey,
    })
    .refine((v) => calendarOnly(v.format, v.horizonDays), { message: HORIZON_ONLY_ICAL, path: ['horizonDays'] }),
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
    // The URL is sealed to the row's id, so the id is chosen first.
    const sourceId = input.id ?? newId('src');
    const urlEncrypted = await sealerOf(feedUrls).seal({ orgId: org.orgId, id: sourceId }, input.feedUrl);
    const row = write(
      org.dataSources.stage.insert({
        id: sourceId,
        name: input.name,
        format: input.format,
        urlEncrypted,
        refreshS: input.refreshS,
        horizonDays: input.horizonDays ?? null,
      }),
    );
    return { dataSource: viewOf(row) };
  },
});

const updateDataSource = defineTool({
  name: 'update_data_source',
  description:
    'Change a data source: its name, feed URL, refresh or calendar look-ahead (null clears it). A new URL is polled afresh within a minute. Only what is given changes. Returns { dataSource }.',
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  input: z.object({
    dataSourceId: id('data source'),
    name: name('data source').optional(),
    feedUrl: feedUrl.optional(),
    refreshS: refreshS.optional(),
    horizonDays: horizonDays.nullable().optional(),
  }),
  output: dataSourceResult,
  example: { dataSourceId: 'weather', refreshS: 600 },
  target,
  handler: async ({ org, input, write, feedUrls }) => {
    const row = await requireSource(org, input.dataSourceId);
    if (!calendarOnly(row.format, input.horizonDays)) throw new ToolError('invalid_input', HORIZON_ONLY_ICAL);
    // A new feed starts clean: the old one's validators and failures say nothing about it.
    const fresh = input.feedUrl
      ? {
          urlEncrypted: await sealerOf(feedUrls).seal({ orgId: org.orgId, id: row.id }, input.feedUrl),
          etag: null,
          lastModified: null,
          failures: 0,
          lastError: null,
          nextPollAt: 0,
        }
      : {};
    const updated = write(org.dataSources.stage.update(row, { name: input.name, refreshS: input.refreshS, horizonDays: input.horizonDays, ...fresh }));
    return { dataSource: viewOf(updated) };
  },
});

/** Spots whose draft or published version binds a field to `dataSourceId`. */
async function spotsBinding(org: OrgScope, dataSourceId: string): Promise<string[]> {
  const binds = (json: string | null | undefined) => {
    if (json == null) return false;
    const bindings: unknown = JSON.parse(json);
    return isObject(bindings) && Object.values(bindings).some((b) => isObject(b) && b.source === dataSourceId);
  };
  return (await org.spots.list()).filter((s) => binds(s.bindingsJson) || binds(published(s)?.bindingsJson)).map((s) => s.id);
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

export const dataSourceTools = [listDataSources, getDataSource, createDataSource, updateDataSource, deleteDataSource];
