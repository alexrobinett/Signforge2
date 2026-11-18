/**
 * SignForge API Worker. Three route trees, one per kind of caller, and no credential is accepted
 * on another's tree: `/api` for CMS users (session cookie), `/v1/device` for screens (bearer
 * credential), `/mcp` for agents (OAuth, Milestone 4). See docs/backend-plan.md. `/admin` takes
 * `sf push` uploads behind a deploy secret (src/admin) and publishes through the tool registry.
 * The Cron Trigger runs the data-source poller (src/data).
 *
 * Each tree is its own Hono app with its own authentication middleware, mounted here. Nothing
 * authenticates at this level, so a tree accepts only what its own middleware checks.
 */
import { Hono } from 'hono';
import { MANIFEST_SCHEMA } from '@signforge/contract';
import { admin } from './admin';
import { device } from './device';
import { createApi } from './api';
import { pollDataSources } from './data/poller';
import { refuseSession } from './auth/guards';

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

export default {
  fetch: app.fetch,
  // The data-source poller, every minute (wrangler.jsonc `triggers`).
  scheduled(controller, env, ctx) {
    ctx.waitUntil(pollDataSources(env, { now: controller.scheduledTime }));
  },
} satisfies ExportedHandler<Env>;

// Durable Object classes are exported from the Worker's entry point.
export { ScreenObject } from './device/screen-object';
