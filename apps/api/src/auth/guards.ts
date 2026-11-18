import type { MiddlewareHandler } from 'hono';
import { COOKIE_PREFIX } from './options';

const SESSION_COOKIE = new RegExp(`^(?:__Secure-)?${COOKIE_PREFIX}\\.`);

/** True if the request carries any of our auth cookies. */
function hasSessionCookie(req: Request): boolean {
  const header = req.headers.get('cookie');
  if (!header) return false;
  return header.split(';').some((c) => SESSION_COOKIE.test(c.trim().split('=')[0] ?? ''));
}

/**
 * For `/v1/device`: a screen authenticates with its bearer credential only. A request carrying a
 * user's session cookie is refused outright, so a browser session can never act as a screen.
 */
export const refuseSession: MiddlewareHandler = async (c, next) => {
  if (hasSessionCookie(c.req.raw)) return c.json({ error: 'session_not_accepted' }, 401);
  return next();
};
