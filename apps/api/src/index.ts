/**
 * SignForge API Worker. Three route trees, one per kind of caller, and no credential is accepted
 * on another's tree: `/api` for CMS users (session cookie), `/v1/device` for screens (bearer
 * credential), `/mcp` for agents (OAuth, Milestone 4). See docs/backend-plan.md.
 */
import { Hono } from 'hono';
import { MANIFEST_SCHEMA } from '@signforge/contract';

// `Env` is generated from wrangler.jsonc by `wrangler types` (worker-configuration.d.ts).
const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) =>
  c.json({ ok: true, environment: c.env.ENVIRONMENT, version: c.env.BUILD_VERSION, manifestSchema: MANIFEST_SCHEMA }),
);

export default app;
