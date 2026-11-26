/**
 * The data-source poller (docs/backend-plan.md, Data sources). A one-minute Cron Trigger claims
 * the sources that are due, in every org, and polls each: a guarded, conditional fetch
 * (./fetch.ts), converted by its format (`@signforge/feeds`), checked against the fields that
 * published spots bind to it by the rule a screen keeps a snapshot by (player-core's
 * `snapshotFit`), and written only when the data changed. Screens get the snapshots on their next
 * sync. A table (`csv`, `json-table`) that lacks a column a published spot maps fails
 * as `missing-column`, whatever else it fills: the person renamed or dropped a column. Whether a
 * news source's photos are shown counts what screens play as well (their desired manifests, an
 * `sf push`'s too, #481); its fit counts published spots alone, each screen checking its own.
 *
 * A provider source (`format: 'provider'`) is read through its connection's adapter instead
 * (../connectors): the provider's fixed hosts only, with the connection's grant, refreshed
 * first when it runs out within REFRESH_MARGIN_MS, or once when the provider refuses the access
 * token. A refresh the provider refuses marks the connection `needs_reconnect`, and its sources
 * then fail as `needs-reconnect` without asking the provider again, until a person reconnects it.
 * Sources sharing a connection refresh it once per run.
 *
 * A news (`rss`) source whose photos are active gives its first stories the org's copies of their
 * photos, and once its snapshot is saved (so a refused one costs no fetches), queues the ones it
 * has none of yet (./feed-photos.ts).
 *
 * Writes per poll: one row (the source's next poll) and, when the feed still says the same, the
 * snapshot's `checked_at`, or when it changed, the snapshot; for a provider source, also the
 * connection's grant when it was refreshed. A failure backs off, doubling the refresh interval
 * up to 6 hours, and keeps the last good snapshot.
 */
import { type Binding, canonicalJson, MAX_SNAPSHOT_BYTES, snapshotBytes } from '@signforge/contract';
import { claimDueDataSources, type DataSourceRow, type OrgScope, scoped } from '@signforge/db';
import { FeedError, normaliseFeed, parseNews } from '@signforge/feeds';
import { type BindingSpot, type BoundField, boundFields, hasBoundListImage, PLAYER_LOCALE, snapshotFit } from '@signforge/player-core';
import { manifestSummary } from '../device/manifests';
import { type ConnectorDeps, connectorDeps, workerFetch } from '../connectors';
import { type Grant, type ProviderAdapter, ProviderError, type ProviderFetch, providerFetch } from '../connectors/adapter';
import { openGrant, sealGrant } from '../connectors/vault';
import { openFeedUrl } from './cipher';
import { FetchError, type FetchGuards, feedGuards, guardedFetch } from './fetch';
import {
  attachFeedPhotos,
  cfPhotoQueue,
  enqueueFeedPhotos,
  type PhotoPlan,
  type PhotoPoll,
  type PhotoQueue,
  planPhotoRecheck,
  sha256Hex,
  startPhotoPoll,
} from './feed-photos';

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
  photoQueue: PhotoQueue;
  /** Per connection, the grant this run uses (and per connection again, `!` after its id, the one it refreshed after a refusal): shared by its sources. */
  grants: Map<string, Promise<Held>>;
  /** Per org, the fields published spots bind to each source (`snapshotFit` and photos), loaded in `pollInit` once per org per run. */
  boundByOrg: Map<string, Map<string, BoundField[]>>;
  /** Per org, the fields its screens' desired manifests bind (#481): for whether photos are shown, never for fit. */
  playedByOrg: Map<string, Map<string, BoundField[]>>;
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
    photoQueue = cfPhotoQueue(env.FEED_IMAGES),
  }: { now?: number; guards?: FetchGuards; connectors?: ConnectorDeps; photoQueue?: PhotoQueue } = {},
): Promise<void> {
  const claimed = await claimDueDataSources(env.DB, now, { limit: POLLS_PER_RUN, leaseMs: LEASE_MS, backoffMaxMs: BACKOFF_MAX_MS });
  const pass: Run = { env, now, guards, connectors, photoQueue, grants: new Map(), boundByOrg: new Map(), playedByOrg: new Map() };
  // Load each org's claimed sources, snapshot versions, and published bound spots in one D1 batch per org.
  const idsByOrg = new Map<string, string[]>();
  for (const { orgId, id } of claimed) {
    const list = idsByOrg.get(orgId) ?? [];
    list.push(id);
    idsByOrg.set(orgId, list);
  }
  const rowsByKey = new Map<string, { org: OrgScope; source: DataSourceRow; snapshotVersion: string | null }>();
  // One org's load failing (D1, or R2 for its manifests) skips that org's sources this run, never another org's: they stay
  // leased, and are polled again once the lease runs out. Never as "photos not shown", which would save a snapshot without
  // the photos a screen holds.
  const loads = await Promise.allSettled(
    [...idsByOrg].map(async ([orgId, ids]) => {
      const org = scoped(env.DB, orgId);
      const init = await org.dataSources.pollInit(ids);
      const bound = computeBoundFields(init.spots, init.locales);
      // What screens play counts too (#481): a manifest `sf push` uploaded has no published spot behind it. Read from R2
      // only when a claimed source's photos are on and no published spot shows them, as sync and the blob route read them.
      const unshown = init.rows.some(({ source }) => source.format === 'rss' && source.photos && !hasBoundListImage(bound.get(source.id) ?? []));
      const played = new Map<string, BoundField[]>();
      if (unshown) {
        const summaries = await Promise.all(init.manifests.map((m) => manifestSummary(env.BLOBS, orgId, m.screenId, m.manifestId)));
        for (const summary of summaries)
          for (const [sourceId, fields] of summary?.bound ?? []) played.set(sourceId, [...(played.get(sourceId) ?? []), ...fields]);
      }
      pass.boundByOrg.set(orgId, bound);
      pass.playedByOrg.set(orgId, played);
      for (const item of init.rows) rowsByKey.set(`${orgId}:${item.source.id}`, { org, ...item });
    }),
  );
  for (const l of loads) if (l.status === 'rejected') console.error("[poller] an org's sources could not be loaded", l.reason);
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

async function pollOne(run: Run, org: OrgScope, row: DataSourceRow, snapshotVersion: string | null, locator: string | undefined): Promise<void> {
  const { now } = run;
  const nextPollAt = now + row.refreshS * 1000;
  const bound = run.boundByOrg.get(org.orgId)?.get(row.id) ?? [];
  const photo = startPhotoPoll(row, [...bound, ...(run.playedByOrg.get(org.orgId)?.get(row.id) ?? [])], now);
  try {
    if (!locator) throw new PollFailure('sealed-url');
    const ok = { nextPollAt, failures: 0, lastError: null };
    const res = await read(run, org, row, locator, photo);
    if (res.status === 'not-modified') {
      const { held } = await org.dataSources.savePoll(row.id, {
        source: ok,
        checkedAt: now,
        ...(photo ? { photos: { read: photo.read, hold: res.photos } } : {}),
      });
      await enqueueFeedPhotos(run.photoQueue, org.orgId, row.id, held);
      return;
    }
    const { data, photos } = res;
    if (snapshotBytes(data) > MAX_SNAPSHOT_BYTES) throw new PollFailure('too-large');
    const dataJson = canonicalJson(data);
    const version = await sha256Hex(new TextEncoder().encode(dataJson));
    const source = { ...ok, etag: res.etag, lastModified: res.lastModified };
    const snapshotChanged = snapshotVersion !== version;
    if (snapshotChanged) {
      const { refused } = snapshotFit(bound, data);
      if (refused) throw new PollFailure(refused);
    }
    const { held } = await org.dataSources.savePoll(row.id, {
      source,
      ...(snapshotChanged ? { snapshot: { version, fetchedAt: now, checkedAt: now, dataJson } } : { checkedAt: now }),
      ...(photo ? { photos: { read: photo.read, stories: res.stories ? { version, urls: res.stories } : null, hold: photos } } : {}),
    });
    await enqueueFeedPhotos(run.photoQueue, org.orgId, row.id, held);
  } catch (e) {
    if (!(e instanceof PollFailure || e instanceof FetchError || e instanceof FeedError || e instanceof ProviderError)) throw e;
    const failures = row.failures + 1;
    const backoff = Math.min(row.refreshS * 1000 * 2 ** failures, BACKOFF_MAX_MS);
    await org.dataSources.savePoll(row.id, {
      source: { nextPollAt: now + backoff, failures, lastError: e.code },
      ...(photo ? { photos: { read: photo.read } } : {}),
    });
  }
}

/** `photos`: a news source's photo URLs to queue once its snapshot is saved (or confirmed on 304). */
type Read =
  | { status: 'not-modified'; photos?: PhotoPlan }
  | {
      status: 'ok';
      data: unknown;
      etag: string | null;
      lastModified: string | null;
      stories?: (string | null)[];
      photos?: PhotoPlan;
    };

/** What the source says now: a feed fetched through the guards and converted, or a provider's resource through its adapter. */
async function read(run: Run, org: OrgScope, row: DataSourceRow, locator: string, photo: PhotoPoll | undefined): Promise<Read> {
  const { format } = row;
  if (format === 'provider') {
    if (!row.connectionId) throw new PollFailure('disconnected');
    return { status: 'ok', data: await providerData(run, org, row.connectionId, locator), etag: null, lastModified: null };
  }
  // A calendar's events depend on the time as well as the feed (past events drop out), so it is fetched whole every time.
  // An RSS source reads whole whenever Feed photos says its next poll cannot take a 304.
  const skipValidators = format === 'ical' || Boolean(photo?.read.readWhole);
  const validators = skipValidators ? {} : { etag: row.etag, lastModified: row.lastModified };
  const res = await guardedFetch(locator, validators, run.guards);
  if (res.status === 'not-modified') {
    const photos = photo ? await planPhotoRecheck(org, photo, run.now) : undefined;
    return photos ? { status: 'not-modified', photos } : res;
  }
  const validated = { etag: res.etag, lastModified: res.lastModified };
  if (photo?.shown) {
    // The feed's URL, which a photo's relative link resolves against last.
    const { data, stories, toQueue } = await attachFeedPhotos(org, parseNews(res.body, { url: locator }), run.now);
    return { status: 'ok', data, ...validated, stories, photos: toQueue };
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
