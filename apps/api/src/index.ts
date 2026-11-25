/**
 * SignForge API Worker. Three route trees, one per kind of caller, and no credential is accepted
 * on another's tree: `/api` for CMS users (session cookie), `/v1/device` for screens (bearer
 * credential), `/mcp` for agents (OAuth access token, src/mcp). See docs/backend-plan.md. `/admin` takes
 * `sf push` uploads behind a deploy secret (src/admin) and publishes through the tool registry.
 * Two queue consumers: one tells the screens a publish switched (src/publish.ts), the other stores
 * the photos of news feeds' stories that the poller queues (src/data/feed-photos.ts).
 * Two Cron Triggers: the data-source poller (src/data) and the offline alert check (src/alerts.ts) with the
 * alert deliveries it queues (src/deliveries.ts), whose first run each UTC day also expires old idempotency
 * keys, audit rows and alert deliveries (packages/db retention.ts), and prunes OAuth clients nobody consented to. The poller's 01:00 UTC run
 * sweeps unneeded feed photos (src/data/feed-photos.ts), and at 02:00 UTC what an org stores that nothing needs (src/storage.ts).
 *
 * Each tree is its own Hono app with its own authentication middleware, mounted here. Nothing
 * authenticates at this level, so a tree accepts only what its own middleware checks.
 */
import { Hono } from 'hono';
import { MANIFEST_SCHEMA } from '@signforge/contract';
import { admin } from './admin';
import { device } from './device';
import { createApi } from './api';
import { mcp } from './mcp';
import {
  AUDIT_ROWS_PER_RUN,
  expireAlertDeliveries,
  expireAuditRows,
  expireIdempotencyKeys,
  expirePublishRequests,
  pruneUnconsentedClients,
} from '@signforge/db';
import { checkScreenAlerts, finishRollouts } from './alerts';
import { deliverAlerts } from './deliveries';
import { type FeedImageJob, photoDeps, r2PhotoBlobs, storeFeedImages, sweepFeedPhotos } from './data/feed-photos';
import { sweepStorage } from './storage';
import { pollDataSources } from './data/poller';
import { refuseSession } from './auth/guards';
import { emailSenderFor } from './email';
import type { PublishNotice } from './device/screens';
import { deliverNotices } from './publish';

// `Env` is generated from wrangler.jsonc by `wrangler types` (worker-configuration.d.ts).
export const app = new Hono<{ Bindings: Env }>();

// A user's session is never a screen's credential (M3-09). The socket upgrade is let through with
// one, because a test screen on the CMS's hostname (M3-41) cannot keep its user's cookie off a
// WebSocket handshake as it does off its fetches. The socket route reads only its ticket, which
// only a credential's sync mints, and passes no cookie on.
app.use('/v1/device/*', (c, next) => (c.req.path === '/v1/device/ws' ? next() : refuseSession(c, next)));

app.get('/health', (c) => c.json({ ok: true, environment: c.env.ENVIRONMENT, version: c.env.BUILD_VERSION, manifestSchema: MANIFEST_SCHEMA }));

app.route('/v1/device', device);
app.route('/api', createApi());
app.route('/admin', admin);
app.route('/', mcp);

const FIVE_MIN_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const FEED_IMAGE_CLEANUP_MS = 60 * 60_000;
/** The storage sweep's minute (#235): 02:00 UTC, its own invocation as the feed photos' is. */
const STORAGE_SWEEP_MS = 2 * 60 * 60_000;

/** Each Cron Trigger's job, by its schedule as written in wrangler.jsonc `triggers`. */
const CRON_JOBS: Record<string, (env: Env, now: number) => Promise<unknown>> = {
  // Give feed cleanup its own invocation without exceeding the account's five Free Cron Triggers.
  '* * * * *': (env, now) =>
    now % DAY_MS === FEED_IMAGE_CLEANUP_MS
      ? sweepFeedPhotos(env.DB, r2PhotoBlobs(env.BLOBS), now)
      : now % DAY_MS === STORAGE_SWEEP_MS
        ? sweepStorage(env.DB, env.BLOBS, () => Date.now())
        : pollDataSources(env, { now }),
  // The offline alert check and the finished rollouts (src/alerts.ts), every 5 minutes: screens sync that
  // often, so a shorter period finds nothing new. Then the alert deliveries to Slack and webhooks (src/deliveries.ts), the new ones and the retries due,
  // started once the check has queued its alerts and whether or not it failed, so neither holds up the other.
  // The midnight run spends up to 21 D1 calls on retention, 1 on pruning OAuth clients nobody consented to
  // (M4-04), 14 on deliveries, and 4 on finding alerts and rollouts. One write per check leaves room for their
  // context reads and fallback writes (up to 5 calls each, 50 total). The remaining work is due again at 00:05.
  // Settled, not raced: a failed retention delete must not end the run before an alert's email goes.
  '*/5 * * * *': async (env, now) => {
    const daily = now % DAY_MS < FIVE_MIN_MS;
    const email = emailSenderFor(env);
    const limit = daily ? 1 : undefined;
    const checks = [checkScreenAlerts(env, email, now, limit), finishRollouts(env, email, now, limit)];
    const results = await Promise.allSettled([
      ...checks,
      // Claimed at the time it claims: the checks may have taken minutes, and a lease counted from the
      // schedule could run out before the sends do, letting the next run send them again.
      Promise.allSettled(checks).then(() => deliverAlerts(env, email, { now: Date.now() })),
      ...(daily
        ? [
            expireAuditRows(env.DB, now),
            expireIdempotencyKeys(env.DB, now),
            expireAlertDeliveries(env.DB, now),
            pruneUnconsentedClients(env.DB, now),
            expirePublishRequests(env.DB, now),
          ]
        : []),
    ]);
    const audit = results[checks.length + 1];
    if (audit?.status === 'fulfilled' && audit.value === AUDIT_ROWS_PER_RUN)
      console.warn(`audit retention hit its cap of ${AUDIT_ROWS_PER_RUN} rows: a backlog is left for the next runs`);
    const failed = results.filter((r) => r.status === 'rejected').map((r) => r.reason);
    if (failed.length) throw new AggregateError(failed, 'five-minute cron job failed');
  },
};

/** Whether a batch is the photos queue's: each environment names its queues with its own suffix (wrangler.jsonc). */
const isFeedImages = (batch: MessageBatch<PublishNotice | FeedImageJob>): batch is MessageBatch<FeedImageJob> =>
  batch.queue.startsWith('signforge-feed-images');
const isNotices = (batch: MessageBatch<PublishNotice | FeedImageJob>): batch is MessageBatch<PublishNotice> =>
  batch.queue.startsWith('signforge-publish-notices');

export default {
  fetch: app.fetch,
  queue: async (batch, env) => {
    if (isFeedImages(batch)) return storeFeedImages(batch, env.DB, photoDeps(env, Date.now()));
    if (isNotices(batch)) return deliverNotices(batch, env);
    throw new Error(`No consumer for queue "${batch.queue}"`);
  },
  scheduled(controller, env, ctx) {
    const job = CRON_JOBS[controller.cron];
    if (!job) throw new Error(`No job for cron "${controller.cron}"`);
    ctx.waitUntil(job(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env, PublishNotice | FeedImageJob>;

// Durable Object classes are exported from the Worker's entry point.
export { ScreenObject } from './device/screen-object';
export { AgentGrantObject } from './agents/grant-object';
export { OrgObject } from './publish';
