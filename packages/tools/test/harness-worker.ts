/**
 * A Worker for the browser upload test (e2e/upload.test.ts): the tool dispatcher over a local D1 and R2, as the API's
 * `/api/tools` route runs it, without sign-in. The browser page and the bucket's S3 API (served by
 * Miniflare at /cdn-cgi/local/r2/s3) share its origin.
 */
import { scoped } from '@signforge/db';
import { seedOrganization } from '@signforge/db/testing';
import { dispatch, r2Presigner, registry, type Caller } from '../src';

interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  /** JSON: each migration's SQL statements, in order. */
  MIGRATIONS: string;
  S3: string;
}

const ORG = 'org-e2e';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('<!doctype html><meta charset="utf-8"><title>upload</title><body></body>', { headers: { 'content-type': 'text/html' } });
    }
    if (request.method === 'POST' && url.pathname === '/setup') {
      for (const statements of JSON.parse(env.MIGRATIONS) as string[][]) for (const sql of statements) await env.DB.prepare(sql).run();
      await seedOrganization(env.DB, ORG);
      return Response.json({ ok: true });
    }
    if (request.method === 'POST' && url.pathname.startsWith('/use/')) {
      // A spot that shows the asset, as the spot editor (M3-16) will make one.
      const spot = await scoped(env.DB, ORG).spots.insert({ name: 'Uses it', kind: 'image', durationMs: 8000, assetId: url.pathname.slice(5), fit: 'cover' });
      return Response.json({ spotId: spot.id });
    }
    const tool = /^\/tools\/([a-z_]+)$/.exec(url.pathname);
    if (request.method === 'POST' && tool) {
      const s3 = JSON.parse(env.S3) as { bucket: string; accessKeyId: string; secretAccessKey: string };
      const caller: Caller = {
        org: scoped(env.DB, ORG), role: 'owner', actor: { kind: 'user', id: 'user-e2e', clientId: 'cms' }, blobs: env.BLOBS,
        uploads: r2Presigner({ endpoint: `${url.origin}/cdn-cgi/local/r2/s3`, ...s3 }),
      };
      const result = await dispatch(registry, tool[1]!, await request.json(), caller);
      return Response.json(result, { status: result.ok ? 200 : result.error === 'conflict' ? 409 : 400 });
    }
    return new Response('not found', { status: 404 });
  },
};
