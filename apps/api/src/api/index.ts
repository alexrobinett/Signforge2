/**
 * `/api`: the CMS's tree. Callers are people with a session cookie; a device credential
 * (`Authorization` header) is refused here, as a session is refused on `/v1/device`.
 *
 * - `/api/auth/*` is Better Auth: email code and GitHub sign-in, organizations, invitations.
 * - `/api/session` says who is signed in and their active org, if any.
 * - Every other route runs behind `requireOrg`, which re-checks membership of the active org
 *   on every request and hands handlers `c.var.org`, a `scoped(db, orgId)`.
 */
import { Hono, type MiddlewareHandler } from 'hono';
import { findMembership, scoped, type OrgScope } from '@signforge/db';
import { createAuth, ROLES, type Auth, type AuthSession, type Role } from '../auth';
import { emailSenderFor, type EmailSender } from '../email';

export interface ApiVars {
  auth: Auth;
  session: AuthSession;
  /** Set by `requireOrg`. */
  orgId: string;
  role: Role;
  org: OrgScope;
}
export type ApiEnv = { Bindings: Env; Variables: ApiVars };

export interface ApiDeps {
  /** Defaults to `emailSenderFor(env)`. Tests pass a recorder. */
  email?: EmailSender;
}

const error = (code: string) => ({ error: code });

/** Refuse a device credential on the CMS tree. */
const refuseDeviceCredential: MiddlewareHandler<ApiEnv> = async (c, next) => {
  if (c.req.header('authorization')) return c.json(error('device_credential_not_accepted'), 401);
  await next();
};

/** A signed-in user, from the session cookie (or its cache cookie). */
export const requireSession: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json(error('unauthenticated'), 401);
  c.set('session', session);
  await next();
};

/**
 * The session's active org, with membership re-checked against the database. The session (and
 * its cache cookie, for up to five minutes) only says which org is active; whether the user is
 * still a member, and in what role, is read fresh every time. The org comes from the session
 * alone, never from the request, so ids from another org find nothing.
 */
export const requireOrg: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const orgId = c.var.session.session.activeOrganizationId;
  if (!orgId) return c.json(error('no_active_organization'), 403);
  const membership = await findMembership(c.env.DB, orgId, c.var.session.user.id);
  if (!membership || !(ROLES as string[]).includes(membership.role)) return c.json(error('not_a_member'), 403);
  c.set('orgId', orgId);
  c.set('role', membership.role as Role);
  c.set('org', scoped(c.env.DB, orgId));
  await next();
};

/** The `/api` sub-app. Routes added to it after this call run behind `requireOrg`. */
export function createApi(deps: ApiDeps = {}) {
  const api = new Hono<ApiEnv>();

  api.use('*', refuseDeviceCredential);
  api.use('*', async (c, next) => {
    c.set('auth', createAuth(c.env, c.req.raw, deps.email ?? emailSenderFor(c.env)));
    await next();
  });

  api.on(['GET', 'POST'], '/auth/*', (c) => c.var.auth.handler(c.req.raw));

  api.get('/session', requireSession, async (c) => {
    const { user, session } = c.var.session;
    const orgId = session.activeOrganizationId ?? null;
    const membership = orgId ? await findMembership(c.env.DB, orgId, user.id) : undefined;
    return c.json({
      user: { id: user.id, email: user.email, name: user.name },
      organization: orgId && membership ? { id: orgId, role: membership.role } : null,
    });
  });

  api.use('*', requireSession, requireOrg);
  return api;
}
