/**
 * Deploy-secret authentication for `/admin`. TEMPORARY: the admin tree exists so `sf push` can
 * upload builds before the CMS uploads assets (M3-14) and agents hold OAuth grants (Milestone 4).
 *
 * `ADMIN_TOKEN` is a Worker secret (locally, `apps/api/.dev.vars`, which is gitignored). While it
 * is unset or empty the whole tree answers 404, as if it did not exist. The header read is
 * `Authorization: Bearer`; no other tree accepts this token.
 */
import { createMiddleware } from 'hono/factory';

/** The secret is not in wrangler.jsonc, so `wrangler types` only knows it when `.dev.vars` exists. */
export type AdminBindings = Env & { ADMIN_TOKEN?: string };
export type AdminEnv = { Bindings: AdminBindings };

const json = (status: number, error: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json', ...headers } });

const encoder = new TextEncoder();
const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(s)));

/** Constant-time: both sides are hashed to 32 bytes first, so length leaks nothing either. */
async function sameSecret(presented: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(presented), digest(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export const adminAuth = createMiddleware<AdminEnv>(async (c, next) => {
  const expected = c.env.ADMIN_TOKEN;
  if (!expected) return json(404, 'not found');
  const match = /^Bearer[ ]+(\S+)$/i.exec(c.req.header('authorization') ?? '');
  if (!match || !(await sameSecret(match[1]!, expected))) return json(401, 'unauthorized', { 'www-authenticate': 'Bearer realm="admin"' });
  await next();
});
