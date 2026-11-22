/**
 * The data-source poller (docs/backend-plan.md, Data sources). A one-minute Cron Trigger claims
 * the sources that are due, in every org, and polls each: a guarded, conditional fetch
 * (./fetch.ts), converted by its format (`@signforge/feeds`), checked against the fields that
 * published spots bind to it by the rule a screen keeps a snapshot by (player-core's
 * `snapshotFit`), and written only when the data changed. Screens get the snapshots on their next
 * sync. A table (`csv`, `json-table`) that lacks a column a published spot maps fails
 * as `missing-column`, whatever else it fills: the person renamed or dropped a column.
 *
 * A provider source (`format: 'provider'`) is read through its connection's adapter instead
 * (../connectors): the provider's fixed hosts only, with the connection's grant, refreshed
 * first when it runs out within REFRESH_MARGIN_MS, or once when the provider refuses the access
 * token. A refresh the provider refuses marks the connection `needs_reconnect`, and its sources
 * then fail as `needs-reconnect` without asking the provider again, until a person reconnects it.
 * Sources sharing a connection refresh it once per run.
 *
 * A news (`rss`) source with `photos` on — when at least one published spot binds it to a template
 * field that uses images (an `image` field or a `list` whose items have an `image` property) —
 * gives its first stories the org's copies of their photos, and once its snapshot is saved (so a
 * refused one costs no fetches), queues the ones it has none of yet (./images.ts).
 *
 * Writes per poll: one row (the source's next poll) and, when the feed still says the same, the
 * snapshot's `checked_at`, or when it changed, the snapshot; for a provider source, also the
 * connection's grant when it was refreshed. A failure backs off, doubling the refresh interval
 * up to 6 hours, and keeps the last good snapshot.
 */
import { type Binding, canonicalJson, MAX_SNAPSHOT_BYTES, snapshotBytes } from '@signforge/contract';
import { claimDueDataSources, type DataSourceRow, type OrgScope, scoped } from '@signforge/db';
import { FeedError, normaliseFeed, parseNews } from '@signforge/feeds';
import { type BindingSpot, type BoundField, boundFields, PLAYER_LOCALE, snapshotFit } from '@signforge/player-core';
import { type ConnectorDeps, connectorDeps, workerFetch } from '../connectors';
import { type Grant, type ProviderAdapter, ProviderError, type ProviderFetch, providerFetch } from '../connectors/adapter';
import { openGrant, sealGrant } from '../connectors/vault';
import { openFeedUrl } from './cipher';
import { FetchError, type FetchGuards, feedGuards, guardedFetch } from './fetch';
import { newsWithPhotos, planPhotos, queuePhotos, sha256Hex } from './images';

/**
 * Free D1 allows 50 queries per invocation. Allow one claim and at most seven calls per source:
 * an org load, a connection read, a grant save, two calls for a refused second refresh, a poll
 * save and its error-path lookup. An RSS source with photos needs at most five.
 */
const POLLS_PER_RUN = 6;
/** How long a claimed source is held for its run at least: past the fetch's 5 seconds, with redirects. The claim holds it for its next backoff when that is longer. */
const LEASE_MS = 2 * 60_000;
export const BACKOFF_MAX_MS = 6 * 3_600_000;
/** Fetches in flight to one host at once (docs/backend-plan.md, Limits), or through one connection. */
const PER_HOST = 2;
/** A grant running out sooner than this is refreshed before it is used: past the poll's own lease. */
export const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * Why a poll failed, as `data_sources.last_error` records it: a guard's or a feed's category, or
 * `unfit`; for a provider source a provider's (../connectors/adapter.ts), or the connection's state.
 */
type PollError =
  | FetchError['code']
  | FeedError['code']
  | ProviderError['code']
  | 'unfit'
  | 'missing-column'
  | 'sealed-url'
  | 'sealed-credentials'
  | 'needs-reconnect'
  | 'disconnected'
  | 'provider-unavailable';

/** Thrown for a poll that found something it may not store. */
class PollFailure extends Error {
  constructor(
    readonly code: PollError,
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}

/** What one poll run reads with: the clock, the feed guards, the providers, and the grants this run refreshed. */
interface Run {
  env: Env;
  now: number;
  guards: FetchGuards;
  connectors: ConnectorDeps;
  /** Per connection, the grant this run uses (and per connection again, `!` after its id, the one it refreshed after a refusal): shared by its sources. */
  grants: Map<string, Promise<Held>>;
  /** Serialises per-org photo budget checks + holds within one poll run so concurrent sources cannot overshoot NEW_PER_ORG_PER_DAY. */
  photoQueues: Map<string, Promise<void>>;
  /** Cached per-org published bound fields (`sourceId -> BoundField[]`), loaded in `pollInit` once per org per run. */
  boundByOrg: Map<string, Map<string, BoundField[]>>;
}

/** A grant, and as it is stored: what a refresh of it is saved over. */
interface Held {
  grant: Grant;
  sealed: string;
}

/** Run one poll pass at `now`. */
export async function pollDataSources(
  env: Env,
  {
    now = Date.now(),
    guards = feedGuards(env, workerFetch),
    connectors = connectorDeps(env),
  }: { now?: number; guards?: FetchGuards; connectors?: ConnectorDeps } = {},
): Promise<void> {
  const claimed = await claimDueDataSources(env.DB, now, { limit: POLLS_PER_RUN, leaseMs: LEASE_MS, backoffMaxMs: BACKOFF_MAX_MS });
  const pass: Run = { env, now, guards, connectors, grants: new Map(), photoQueues: new Map(), boundByOrg: new Map() };
  // Load each org's claimed sources, snapshot versions, and published bound spots in one D1 batch per org.
  const idsByOrg = new Map<string, string[]>();
  for (const { orgId, id } of claimed) {
    const list = idsByOrg.get(orgId) ?? [];
    list.push(id);
    idsByOrg.set(orgId, list);
  }
  const rowsByKey = new Map<string, { org: OrgScope; source: DataSourceRow; snapshotVersion: string | null }>();
  await Promise.all(
    [...idsByOrg].map(async ([orgId, ids]) => {
      const org = scoped(env.DB, orgId);
      const init = await org.dataSources.pollInit(ids);
      for (const item of init.rows) {
        rowsByKey.set(`${orgId}:${item.source.id}`, { org, ...item });
      }
      pass.boundByOrg.set(orgId, computeBoundFields(init.spots, init.locales));
    }),
  );
  const hosts = new Map<string, Promise<void>[]>();
  const one = async ({ orgId, id }: { orgId: string; id: string }) => {
    const loaded = rowsByKey.get(`${orgId}:${id}`);
    // Deleted since it was claimed.
    if (!loaded) return;
    const { org, source: row, snapshotVersion } = loaded;
    // The feed URL, or a provider source's resource.
    const url = await openFeedUrl(env, { orgId, id }, row.urlEncrypted);
    const host = row.format === 'provider' ? `connection:${row.connectionId}` : url ? new URL(url).hostname : '';
    // At most PER_HOST at a time per host: each waits for the one PER_HOST places ahead of it.
    const queue = hosts.get(host) ?? [];
    const ahead = queue[queue.length - PER_HOST];
    const run = (async () => {
      await ahead;
      await pollOne(pass, org, row, snapshotVersion, url);
    })();
    queue.push(run.catch(() => undefined));
    hosts.set(host, queue);
    await run;
  };
  const results = await Promise.allSettled(claimed.map(one));
  for (const r of results) if (r.status === 'rejected') console.error('[poller] a poll failed', r.reason);
}

function enqueuePhotos(run: Run, org: OrgScope, sourceId: string, photos: { again: string[]; fresh: string[] }): Promise<void> {
  if (!photos.again.length && !photos.fresh.length) return Promise.resolve();
  const prev = run.photoQueues.get(org.orgId);
  const next = (prev ?? Promise.resolve()).then(() => queuePhotos(run.env, org, sourceId, photos, run.now));
  run.photoQueues.set(org.orgId, next);
  return next;
}

async function pollOne(run: Run, org: OrgScope, row: DataSourceRow, snapshotVersion: string | null, locator: string | undefined): Promise<void> {
  const { now } = run;
  const nextPollAt = now + row.refreshS * 1000;
  const photoRead = row.format === 'rss' ? { generation: row.photoGeneration, now } : undefined;
  try {
    if (!locator) throw new PollFailure('sealed-url');
    const ok = { nextPollAt, failures: 0, lastError: null };
    // Re-checked every poll: skip photo work when no published spot binding this source can display images.
    const bound = run.boundByOrg.get(org.orgId)?.get(row.id) ?? [];
    const wantPhotos = row.format === 'rss' && row.photos ? usesPhotos(bound) : false;
    const res = await read(run, org, row, locator, wantPhotos);
    if (res.status === 'not-modified') {
      await org.dataSources.savePoll(row.id, { source: ok, checkedAt: now, photoRead });
      if (res.photos) await enqueuePhotos(run, org, row.id, res.photos);
      return;
    }
    const { data, photos } = res;
    if (snapshotBytes(data) > MAX_SNAPSHOT_BYTES) throw new PollFailure('too-large');
    const dataJson = canonicalJson(data);
    const version = await sha256Hex(new TextEncoder().encode(dataJson));
    const photoUrls = row.format === 'rss' ? { photoUrlsJson: res.storyPhotoUrls ? JSON.stringify({ stories: res.storyPhotoUrls }) : null } : {};
    const source = { ...ok, etag: res.etag, lastModified: res.lastModified, ...photoUrls };
    if (snapshotVersion === version) await org.dataSources.savePoll(row.id, { source, checkedAt: now, photoRead });
    else {
      const { refused } = snapshotFit(bound, data);
      if (refused) throw new PollFailure(refused);
      await org.dataSources.savePoll(row.id, { source, snapshot: { version, fetchedAt: now, checkedAt: now, dataJson }, photoRead });
    }
    if (photos) await enqueuePhotos(run, org, row.id, photos);
  } catch (e) {
    if (!(e instanceof PollFailure || e instanceof FetchError || e instanceof FeedError || e instanceof ProviderError)) throw e;
    const failures = row.failures + 1;
    const backoff = Math.min(row.refreshS * 1000 * 2 ** failures, BACKOFF_MAX_MS);
    await org.dataSources.savePoll(row.id, { source: { nextPollAt: now + backoff, failures, lastError: e.code }, photoRead });
  }
}

/** `photos`: a news source's photo URLs to queue once its snapshot is saved (or confirmed on 304). */
type Read =
  | { status: 'not-modified'; photos?: { again: string[]; fresh: string[] } }
  | {
      status: 'ok';
      data: unknown;
      etag: string | null;
      lastModified: string | null;
      storyPhotoUrls?: (string | null)[];
      photos?: { again: string[]; fresh: string[] };
    };

function parsePhotoUrls(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    const urls = parsed && typeof parsed === 'object' && 'stories' in parsed ? parsed.stories : parsed;
    return Array.isArray(urls) ? [...new Set(urls.filter((u): u is string => typeof u === 'string'))] : [];
  } catch {
    return [];
  }
}

/** What the source says now: a feed fetched through the guards and converted, or a provider's resource through its adapter. */
async function read(run: Run, org: OrgScope, row: DataSourceRow, locator: string, wantPhotos: boolean): Promise<Read> {
  const { format } = row;
  if (format === 'provider') {
    if (!row.connectionId) throw new PollFailure('disconnected');
    return { status: 'ok', data: await providerData(run, org, row.connectionId, locator), etag: null, lastModified: null };
  }
  // A calendar's events depend on the time as well as the feed (past events drop out), so it is fetched whole every time.
  // An RSS source whose photo URLs have not been recorded yet (e.g. a newly published image binding) also reads whole once so a 304 cannot leave it without photos.
  const skipValidators = format === 'ical' || (format === 'rss' && wantPhotos && row.photoUrlsJson === null);
  const validators = skipValidators ? {} : { etag: row.etag, lastModified: row.lastModified };
  const res = await guardedFetch(locator, validators, run.guards);
  if (res.status === 'not-modified') {
    if (format === 'rss' && wantPhotos && row.photoUrlsJson) {
      const urls = parsePhotoUrls(row.photoUrlsJson);
      if (urls.length) {
        const { again, fresh } = await planPhotos(org, urls, run.now);
        return { status: 'not-modified', photos: { again, fresh } };
      }
    }
    return res;
  }
  const validated = { etag: res.etag, lastModified: res.lastModified };
  if (format === 'rss' && wantPhotos) {
    // The feed's URL, which a photo's relative link resolves against last.
    const { data, storyPhotoUrls, again, fresh } = await newsWithPhotos(org, parseNews(res.body, { url: locator }), run.now);
    return { status: 'ok', data, ...validated, storyPhotoUrls, photos: { again, fresh } };
  }
  return { status: 'ok', data: convert(format, row, res.body, run.now), ...validated };
}

/** A provider resource's data, read with the connection's grant. */
async function providerData(run: Run, org: OrgScope, connectionId: string, resource: string): Promise<unknown> {
  const conn = await org.connections.get(connectionId);
  if (!conn?.credentialsSealed || conn.status === 'disconnected') throw new PollFailure('disconnected');
  // Refused once already: asking again would only be refused again, every poll.
  if (conn.status === 'needs_reconnect') throw new PollFailure('needs-reconnect');
  const adapter = run.connectors.adapters.find((a) => a.provider === conn.provider);
  if (!adapter) throw new PollFailure('provider-unavailable');
  const http = providerFetch(adapter, run.connectors.fetch);
  const sealed = conn.credentialsSealed;
  const shared = (key: string, make: () => Promise<Held>) => {
    let held = run.grants.get(key);
    if (!held) {
      held = make();
      run.grants.set(key, held);
    }
    return held;
  };
  const held = await shared(conn.id, () => usableGrant(run, org, conn, adapter, http, sealed));
  try {
    return await adapter.fetch(resource, held.grant, http);
  } catch (e) {
    if (!(e instanceof ProviderError && e.code === 'unauthorized')) throw e;
    // Refused before its time (revoked, or expired early): refresh once, over what this run stored, and try once more.
    const fresh = await shared(`${conn.id}!`, () => refreshed(run, org, conn, adapter, http, held));
    return adapter.fetch(resource, fresh.grant, http);
  }
}

type Connection = { orgId: string; id: string };

/** The connection's grant, refreshed first if it runs out within the margin. */
async function usableGrant(run: Run, org: OrgScope, conn: Connection, adapter: ProviderAdapter, http: ProviderFetch, sealed: string): Promise<Held> {
  const grant = await openGrant(run.env, conn, sealed);
  // Sealed under another key (CONNECTION_KEY changed): only reconnecting gives it a grant again.
  if (!grant) throw new PollFailure('sealed-credentials');
  const held = { grant, sealed };
  if (grant.expiresAt !== null && grant.expiresAt - REFRESH_MARGIN_MS <= run.now) return refreshed(run, org, conn, adapter, http, held);
  return held;
}

/**
 * A fresh grant, stored over the one it was refreshed from. A refresh the provider refuses
 * marks the connection `needs_reconnect`, unless another run refreshed it meanwhile (a provider
 * that rotates refresh tokens refuses the old one): then that run's grant is used.
 */
async function refreshed(run: Run, org: OrgScope, conn: Connection, adapter: ProviderAdapter, http: ProviderFetch, from: Held): Promise<Held> {
  try {
    const grant = await adapter.refresh(from.grant, http, run.now);
    const sealed = await sealGrant(run.env, conn, grant);
    await org.connections.saveGrant(conn.id, from.sealed, { credentialsSealed: sealed, expiresAt: grant.expiresAt });
    return { grant, sealed };
  } catch (e) {
    if (!(e instanceof ProviderError && e.code === 'invalid_grant')) throw e;
    const now = await org.connections.get(conn.id);
    if (now?.status === 'active' && now.credentialsSealed && now.credentialsSealed !== from.sealed) {
      const other = await openGrant(run.env, now, now.credentialsSealed);
      if (other) return { grant: other, sealed: now.credentialsSealed };
    }
    await org.connections.markNeedsReconnect(conn.id, from.sealed, e.code);
    throw new PollFailure('needs-reconnect', { cause: e });
  }
}

/** The feed body as a snapshot's data, by the source's format. */
function convert(format: Exclude<DataSourceRow['format'], 'provider'>, { horizonDays, rowsPath }: DataSourceRow, body: string, now: number): unknown {
  switch (format) {
    case 'json':
      try {
        return JSON.parse(body);
      } catch (e) {
        throw new PollFailure('malformed', { cause: e });
      }
    case 'ical':
      return normaliseFeed('ical', body, { now: new Date(now), ...(horizonDays ? { horizonDays } : {}) });
    case 'rss':
      // Photos off: no image is looked for, and none named.
      return normaliseFeed('rss', body);
    case 'csv':
    case 'json-table':
      return normaliseFeed(format, body, rowsPath ? { rowsPath } : {});
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * Whether any published spot binding this source uses an `image` field or a `list` whose items
 * hold an `image` property (such as News 2.0, #196/#202). Sources bound only by text-only templates
 * (News 1.4.1, Info frame's crawl) or unbound sources skip photo work altogether.
 */
function usesPhotos(bound: readonly BoundField[]): boolean {
  return bound.some(({ fields, field }) => {
    if (!isObject(fields)) return false;
    const def = fields[field];
    if (!isObject(def)) return false;
    if (def.type === 'image') return true;
    return def.type === 'list' && isObject(def.item) && Object.values(def.item).some((p) => isObject(p) && p.type === 'image');
  });
}

/**
 * The fields published spots bind to each source in an org (drafts do not count: screens play what
 * was published), in each locale the org's screens play in, so the poller refuses only what no
 * screen would keep; each screen checks again in its own (`snapshotFit`).
 */
function computeBoundFields(
  rows: readonly { id: string; publishedJson: string; manifestJson: string | null }[],
  locales: readonly (string | null)[],
): Map<string, BoundField[]> {
  const spots: BindingSpot[] = [];
  for (const row of rows) {
    const spot: unknown = JSON.parse(row.publishedJson);
    if (!isObject(spot) || spot.kind !== 'template' || typeof spot.bindingsJson !== 'string' || typeof spot.templateVersionId !== 'string') continue;
    // Written by the spot tools, which checked them.
    const bindings: Record<string, Binding> = JSON.parse(spot.bindingsJson);
    const manifest: unknown = row.manifestJson ? JSON.parse(row.manifestJson) : undefined;
    spots.push({ id: row.id, fields: isObject(manifest) ? manifest.fields : undefined, bindings });
  }
  if (!spots.length) return new Map<string, BoundField[]>();
  return boundFields(spots, [...new Set(locales.map((l) => l ?? PLAYER_LOCALE))]);
}
