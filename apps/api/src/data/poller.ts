/**
 * The data-source poller (docs/backend-plan.md, Data sources). A one-minute Cron Trigger claims
 * the sources that are due, in every org, and polls each: a guarded, conditional fetch
 * (./fetch.ts), converted by its format (`@signforge/feeds`), checked against the fields that
 * published spots bind to it (./fit.ts), and written only when the data changed. Screens get the snapshots on
 * their next sync.
 *
 * Writes per poll: one row (the source's next poll) and, when the feed still says the same, the
 * snapshot's `checked_at`, or when it changed, the snapshot. A failure backs off, doubling the
 * refresh interval up to 6 hours, and keeps the last good snapshot.
 */
import { canonicalJson, MAX_SNAPSHOT_BYTES, snapshotBytes } from '@signforge/contract';
import { claimDueDataSources, type DataSourceRow, type OrgScope, published, scoped } from '@signforge/db';
import { FeedError, normaliseFeed } from '@signforge/feeds';
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
/** Fetches in flight to one host at once (docs/backend-plan.md, Limits). */
const PER_HOST = 2;

/** Why a poll failed, as `data_sources.last_error` records it: a guard's or a feed's category, or `unfit`. */
type PollError = FetchError['code'] | FeedError['code'] | 'unfit' | 'sealed-url';

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

/** Run one poll pass at `now`. */
export async function pollDataSources(env: Env, { now = Date.now(), guards = workerGuards() }: { now?: number; guards?: FetchGuards } = {}): Promise<void> {
  const claimed = await claimDueDataSources(env.DB, now, { limit: POLLS_PER_RUN, leaseMs: LEASE_MS });
  const hosts = new Map<string, Promise<void>[]>();
  const one = async ({ orgId, id }: { orgId: string; id: string }) => {
    const org = scoped(env.DB, orgId);
    const row = await org.dataSources.get(id);
    // Deleted since it was claimed.
    if (!row) return;
    const url = await openFeedUrl(env, { orgId, id }, row.urlEncrypted);
    const host = url ? new URL(url).hostname : '';
    // At most PER_HOST at a time per host: each waits for the one PER_HOST places ahead of it.
    const queue = hosts.get(host) ?? [];
    const ahead = queue[queue.length - PER_HOST];
    const run = (async () => {
      await ahead;
      await pollOne(org, row, url, now, guards);
    })();
    queue.push(run.catch(() => undefined));
    hosts.set(host, queue);
    await run;
  };
  const results = await Promise.allSettled(claimed.map(one));
  for (const r of results) if (r.status === 'rejected') console.error('[poller] a poll failed', r.reason);
}

async function pollOne(org: OrgScope, row: DataSourceRow, url: string | undefined, now: number, guards: FetchGuards): Promise<void> {
  const nextPollAt = now + row.refreshS * 1000;
  try {
    if (!url) throw new PollFailure('sealed-url');
    // A calendar's events depend on the time as well as the feed (past events drop out), so it is fetched whole every time.
    const validators = row.format === 'ical' ? {} : { etag: row.etag, lastModified: row.lastModified };
    const res = await guardedFetch(url, validators, guards);
    const ok = { nextPollAt, failures: 0, lastError: null };
    if (res.status === 'not-modified') {
      await org.dataSources.savePoll(row.id, { source: ok, checkedAt: now });
      return;
    }
    const data = convert(row, res.body, now);
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
    if (!(e instanceof PollFailure || e instanceof FetchError || e instanceof FeedError)) throw e;
    const failures = row.failures + 1;
    const backoff = Math.min(row.refreshS * 1000 * 2 ** failures, BACKOFF_MAX_MS);
    await org.dataSources.savePoll(row.id, { source: { nextPollAt: now + backoff, failures, lastError: e.code } });
  }
}

/** The feed body as a snapshot's data, by the source's format. */
function convert(row: DataSourceRow, body: string, now: number): unknown {
  switch (row.format) {
    case 'json':
      try {
        return JSON.parse(body);
      } catch (e) {
        throw new PollFailure('malformed', { cause: e });
      }
    case 'ical':
      return normaliseFeed('ical', body, { now: new Date(now), ...(row.horizonDays ? { horizonDays: row.horizonDays } : {}) });
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
