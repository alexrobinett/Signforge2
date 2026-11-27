/**
 * Deploy-secret authentication for `/admin`. TEMPORARY: the admin tree exists so `sf push` can
 * upload builds before the CMS uploads assets (M3-14) and agents hold OAuth grants (Milestone 4).
 *
 * `ADMIN_TOKEN` is a Worker secret (locally, `apps/api/.dev.vars`, which is gitignored). While it
 * is unset, empty or shorter than `MIN_TOKEN_LENGTH` the whole tree answers 404, as if it did not
 * exist. The header read is `Authorization: Bearer`; no other tree accepts this token.
 */
import { createMiddleware } from 'hono/factory';

/** The secret is not in wrangler.jsonc, so `wrangler types` only knows it when `.dev.vars` exists. */
type AdminBindings = Env & { ADMIN_TOKEN?: string };
export type AdminEnv = { Bindings: AdminBindings };

const json = (status: number, error: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json', ...headers } });

const encoder = new TextEncoder();
const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(s)));

/**
 * The shortest secret that turns the tree on. It speaks for every org and nothing limits tries, so it must be one
 * no one can guess: `openssl rand -base64 32` makes 44 characters. A shorter one was typed by a person.
 */
const MIN_TOKEN_LENGTH = 32;

/** Constant-time: both sides are hashed to 32 bytes first, so length leaks nothing either. */
export async function sameSecret(presented: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(presented), digest(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export const adminAuth = createMiddleware<AdminEnv>(async (c, next) => {
  const expected = c.env.ADMIN_TOKEN;
  if (!expected) return json(404, 'not found');
  if (expected.length < MIN_TOKEN_LENGTH) {
    // The caller is told nothing; whoever set the secret reads why here.
    console.warn(`/admin is off: ADMIN_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters. Set a random one (openssl rand -base64 32).`);
    return json(404, 'not found');
  }
  const match = /^Bearer[ ]+(\S+)$/i.exec(c.req.header('authorization') ?? '');
  if (!match || !(await sameSecret(match[1]!, expected))) return json(401, 'unauthorized', { 'www-authenticate': 'Bearer realm="admin"' });
  return next();
});
