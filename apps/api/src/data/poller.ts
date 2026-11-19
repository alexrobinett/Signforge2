/**
 * The data-source poller (docs/backend-plan.md, Data sources). A one-minute Cron Trigger claims
 * the sources that are due, in every org, and polls each: a guarded, conditional fetch
 * (./fetch.ts), converted by its format (`@signforge/feeds`), checked against the fields that
 * published spots bind to it (./fit.ts), and written only when the data changed. Screens get the snapshots on
 * their next sync.
 *
 * A provider source (`format: 'provider'`) is read through its connection's adapter instead
 * (../connectors): the provider's fixed hosts only, with the connection's grant, refreshed
 * first when it runs out within REFRESH_MARGIN_MS, or once when the provider refuses the access
 * token. A refresh the provider refuses marks the connection `needs_reconnect`, and its sources
 * then fail as `needs-reconnect` without asking the provider again, until a person reconnects it.
 * Sources sharing a connection refresh it once per run.
 *
 * Writes per poll: one row (the source's next poll) and, when the feed still says the same, the
 * snapshot's `checked_at`, or when it changed, the snapshot; for a provider source, also the
 * connection's grant when it was refreshed. A failure backs off, doubling the refresh interval
 * up to 6 hours, and keeps the last good snapshot.
 */
import { canonicalJson, MAX_SNAPSHOT_BYTES, snapshotBytes } from '@signforge/contract';
import { claimDueDataSources, type DataSourceRow, type OrgScope, published, scoped } from '@signforge/db';
import { FeedError, normaliseFeed } from '@signforge/feeds';
import { type ConnectorDeps, connectorDeps } from '../connectors';
import { type Grant, type ProviderAdapter, ProviderError, type ProviderFetch, providerFetch } from '../connectors/adapter';
import { openGrant, sealGrant } from '../connectors/vault';
import { openFeedUrl } from './cipher';
import { dohResolver, FetchError, type FetchGuards, guardedFetch } from './fetch';
import { type BoundField, fitsBoundFields } from './fit';

/**
 * Sources polled per run. Each takes three external fetches (two DNS lookups and the feed), more
 * with redirects, and the Free plan allows 50 per invocation; a source not claimed this minute is
 * claimed the next.
 */
const POLLS_PER_RUN = 12;
/** How long a claimed source is held for its run: past the fetch's 5 seconds, with redirects. */
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

/** workerd's `fetch` throws "Illegal invocation" when called as a method of another object, so the guards get a bare function. */
const workerFetch: typeof fetch = (input, init) => fetch(input, init);
const workerGuards = (): FetchGuards => ({ fetch: workerFetch, resolve: dohResolver(workerFetch) });

/** What one poll run reads with: the clock, the feed guards, the providers, and the grants this run refreshed. */
interface Run {
  env: Env;
  now: number;
  guards: FetchGuards;
  connectors: ConnectorDeps;
  /** Per connection, the grant this run uses (and per connection again, `!` after its id, the one it refreshed after a refusal): shared by its sources. */
  grants: Map<string, Promise<Grant>>;
}

/** Run one poll pass at `now`. */
export async function pollDataSources(
  env: Env,
  { now = Date.now(), guards = workerGuards(), connectors = connectorDeps(env) }: { now?: number; guards?: FetchGuards; connectors?: ConnectorDeps } = {},
): Promise<void> {
  const claimed = await claimDueDataSources(env.DB, now, { limit: POLLS_PER_RUN, leaseMs: LEASE_MS });
  const pass: Run = { env, now, guards, connectors, grants: new Map() };
  const hosts = new Map<string, Promise<void>[]>();
  const one = async ({ orgId, id }: { orgId: string; id: string }) => {
    const org = scoped(env.DB, orgId);
    const row = await org.dataSources.get(id);
    // Deleted since it was claimed.
    if (!row) return;
    // The feed URL, or a provider source's resource.
    const url = await openFeedUrl(env, { orgId, id }, row.urlEncrypted);
    const host = row.format === 'provider' ? `connection:${row.connectionId}` : url ? new URL(url).hostname : '';
    // At most PER_HOST at a time per host: each waits for the one PER_HOST places ahead of it.
    const queue = hosts.get(host) ?? [];
    const ahead = queue[queue.length - PER_HOST];
    const run = (async () => {
      await ahead;
      await pollOne(pass, org, row, url);
    })();
    queue.push(run.catch(() => undefined));
    hosts.set(host, queue);
    await run;
  };
  const results = await Promise.allSettled(claimed.map(one));
  for (const r of results) if (r.status === 'rejected') console.error('[poller] a poll failed', r.reason);
}

async function pollOne(run: Run, org: OrgScope, row: DataSourceRow, locator: string | undefined): Promise<void> {
  const { now } = run;
  const nextPollAt = now + row.refreshS * 1000;
  try {
    if (!locator) throw new PollFailure('sealed-url');
    const ok = { nextPollAt, failures: 0, lastError: null };
    const res = await read(run, org, row, locator);
    if (res.status === 'not-modified') {
      await org.dataSources.savePoll(row.id, { source: ok, checkedAt: now });
      return;
    }
    const { data } = res;
    if (snapshotBytes(data) > MAX_SNAPSHOT_BYTES) throw new PollFailure('too-large');
    const dataJson = canonicalJson(data);
    const version = await sha256(dataJson);
    const source = { ...ok, etag: res.etag, lastModified: res.lastModified };
    const held = await org.dataSources.snapshot(row.id);
    if (held?.version === version) {
      await org.dataSources.savePoll(row.id, { source, checkedAt: now });
      return;
    }
    if (!fitsBoundFields(await boundFields(org, row.id), data)) throw new PollFailure('unfit');
    await org.dataSources.savePoll(row.id, { source, snapshot: { version, fetchedAt: now, checkedAt: now, dataJson } });
  } catch (e) {
    if (!(e instanceof PollFailure || e instanceof FetchError || e instanceof FeedError || e instanceof ProviderError)) throw e;
    const failures = row.failures + 1;
    const backoff = Math.min(row.refreshS * 1000 * 2 ** failures, BACKOFF_MAX_MS);
    await org.dataSources.savePoll(row.id, { source: { nextPollAt: now + backoff, failures, lastError: e.code } });
  }
}

type Read = { status: 'not-modified' } | { status: 'ok'; data: unknown; etag: string | null; lastModified: string | null };

/** What the source says now: a feed fetched through the guards and converted, or a provider's resource through its adapter. */
async function read(run: Run, org: OrgScope, row: DataSourceRow, locator: string): Promise<Read> {
  const { format } = row;
  if (format === 'provider') {
    if (!row.connectionId) throw new PollFailure('disconnected');
    return { status: 'ok', data: await providerData(run, org, row.connectionId, locator), etag: null, lastModified: null };
  }
  // A calendar's events depend on the time as well as the feed (past events drop out), so it is fetched whole every time.
  const validators = format === 'ical' ? {} : { etag: row.etag, lastModified: row.lastModified };
  const res = await guardedFetch(locator, validators, run.guards);
  if (res.status === 'not-modified') return res;
  return { status: 'ok', data: convert(format, row.horizonDays, res.body, run.now), etag: res.etag, lastModified: res.lastModified };
}

/** A provider resource's data, read with the connection's grant. */
async function providerData(run: Run, org: OrgScope, connectionId: string, resource: string): Promise<unknown> {
  const conn = await org.connections.get(connectionId);
  if (!conn?.credentialsSealed || conn.status === 'disconnected') throw new PollFailure('disconnected');
  // Refused once already: asking again would only be refused again, every poll.
  if (conn.status === 'needs_reconnect') throw new PollFailure('needs-reconnect');
  const adapter = run.connectors.adapters.find((a) => a.provider === conn.provider);
  if (!adapter) throw new PollFailure('provider-unavailable');
  const live = { ...conn, credentialsSealed: conn.credentialsSealed };
  const http = providerFetch(adapter, run.connectors.fetch);
  const shared = (key: string, make: () => Promise<Grant>) => {
    let grant = run.grants.get(key);
    if (!grant) {
      grant = make();
      run.grants.set(key, grant);
    }
    return grant;
  };
  const grant = await shared(conn.id, () => usableGrant(run, org, live, adapter, http));
  try {
    return await adapter.fetch(resource, grant, http);
  } catch (e) {
    if (!(e instanceof ProviderError && e.code === 'unauthorized')) throw e;
    // Refused before its time (revoked, or expired early): refresh once, and try once more.
    const fresh = await shared(`${conn.id}!`, () => refreshed(run, org, live, adapter, http, grant));
    return adapter.fetch(resource, fresh, http);
  }
}

type LiveConnection = NonNullable<Awaited<ReturnType<OrgScope['connections']['get']>>> & { credentialsSealed: string };

/** The connection's grant, refreshed first if it runs out within the margin. */
async function usableGrant(run: Run, org: OrgScope, conn: LiveConnection, adapter: ProviderAdapter, http: ProviderFetch): Promise<Grant> {
  const grant = await openGrant(run.env, conn, conn.credentialsSealed);
  // Sealed under another key (CONNECTION_KEY changed): only reconnecting gives it a grant again.
  if (!grant) throw new PollFailure('sealed-credentials');
  if (grant.expiresAt !== null && grant.expiresAt - REFRESH_MARGIN_MS <= run.now) return refreshed(run, org, conn, adapter, http, grant);
  return grant;
}

/**
 * A fresh grant, stored over the one it was refreshed from. A refresh the provider refuses
 * marks the connection `needs_reconnect`, unless another run refreshed it meanwhile (a provider
 * that rotates refresh tokens refuses the old one): then that run's grant is used.
 */
async function refreshed(run: Run, org: OrgScope, conn: LiveConnection, adapter: ProviderAdapter, http: ProviderFetch, grant: Grant): Promise<Grant> {
  try {
    const fresh = await adapter.refresh(grant, http, run.now);
    await org.connections.saveGrant(conn.id, conn.credentialsSealed, { credentialsSealed: await sealGrant(run.env, conn, fresh), expiresAt: fresh.expiresAt });
    return fresh;
  } catch (e) {
    if (!(e instanceof ProviderError && e.code === 'invalid_grant')) throw e;
    const now = await org.connections.get(conn.id);
    const other =
      now?.status === 'active' && now.credentialsSealed && now.credentialsSealed !== conn.credentialsSealed
        ? await openGrant(run.env, now, now.credentialsSealed)
        : undefined;
    if (other) return other;
    await org.connections.markNeedsReconnect(conn.id, conn.credentialsSealed, e.code);
    throw new PollFailure('needs-reconnect', { cause: e });
  }
}

/** The feed body as a snapshot's data, by the source's format. */
function convert(format: Exclude<DataSourceRow['format'], 'provider'>, horizonDays: number | null, body: string, now: number): unknown {
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
      return normaliseFeed('rss', body);
  }
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** The fields published spots bind to `sourceId`. Drafts do not count: screens play what was published. */
async function boundFields(org: OrgScope, sourceId: string): Promise<BoundField[]> {
  const fieldsOf = new Map<string, unknown>();
  const out: BoundField[] = [];
  for (const draft of await org.spots.list()) {
    const spot = published(draft);
    if (spot?.kind !== 'template' || !spot.bindingsJson || !spot.templateVersionId) continue;
    const bindings: unknown = JSON.parse(spot.bindingsJson);
    if (!isObject(bindings)) continue;
    for (const [field, b] of Object.entries(bindings)) {
      if (!isObject(b) || b.source !== sourceId || typeof b.path !== 'string') continue;
      if (!fieldsOf.has(spot.templateVersionId)) {
        const version = await org.templates.versions.get(spot.templateVersionId);
        const manifest: unknown = version ? JSON.parse(version.manifestJson) : undefined;
        fieldsOf.set(spot.templateVersionId, isObject(manifest) ? manifest.fields : undefined);
      }
      out.push({ fields: fieldsOf.get(spot.templateVersionId), field, path: b.path });
    }
  }
  return out;
}
