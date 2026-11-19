/**
 * `/api`: the CMS's tree. Callers are people with a session cookie; a device credential
 * (`Authorization` header) is refused here, as a session is refused on `/v1/device`.
 *
 * - `/api/auth/*` is Better Auth: email code and GitHub sign-in, organizations, invitations.
 * - `/api/sign-in-options` says which sign-in methods the sign-in page should offer. Public.
 * - `/api/session` says who is signed in and their active org, if any.
 * - Every other route runs behind `requireOrg`, which re-checks membership of the active org
 *   on every request and hands handlers `c.var.org`, a `scoped(db, orgId)`.
 * - `/api/tools` serves the tool registry (./tools.ts). It is the only route here that changes
 *   data, but for the OAuth callback (./connections.ts), a GET because a provider redirects the
 *   browser to it, which changes data only by running `finish_connection` through the
 *   dispatcher; test/routes.test.ts fails if another one does.
 */
import { Hono, type MiddlewareHandler } from 'hono';
import { findMembership, scoped, type OrgScope } from '@signforge/db';
import { createAuth, ROLES, type Auth, type AuthSession, type Role } from '../auth';
import { emailSenderFor, type EmailSender } from '../email';
import type { ConnectorDeps } from '../connectors';
import { mountBlobs } from './blobs';
import { mountConnectionCallback } from './connections';
import { mountTools } from './tools';

interface ApiVars {
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
  /** Defaults to `connectorDeps(env)`, this deployment's providers. Tests pass a fake provider. */
  connectors?: ConnectorDeps;
}

const error = (code: string) => ({ error: code });

/** Refuse a device credential on the CMS tree. */
const refuseDeviceCredential: MiddlewareHandler<ApiEnv> = async (c, next) => {
  if (c.req.header('authorization')) return c.json(error('device_credential_not_accepted'), 401);
  return next();
};

/** A signed-in user, from the session cookie (or its cache cookie). */
const requireSession: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json(error('unauthenticated'), 401);
  c.set('session', session);
  return next();
};

/**
 * The session's active org, with membership re-checked against the database. The session (and
 * its cache cookie, for up to five minutes) only says which org is active; whether the user is
 * still a member, and in what role, is read fresh every time. The org comes from the session
 * alone, never from the request, so ids from another org find nothing.
 */
const requireOrg: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const orgId = c.var.session.session.activeOrganizationId;
  if (!orgId) return c.json(error('no_active_organization'), 403);
  const membership = await findMembership(c.env.DB, orgId, c.var.session.user.id);
  if (!membership || !(ROLES as string[]).includes(membership.role)) return c.json(error('not_a_member'), 403);
  c.set('orgId', orgId);
  c.set('role', membership.role as Role);
  c.set('org', scoped(c.env.DB, orgId));
  return next();
};

/** The `/api` sub-app, with the tool routes. Routes added to it after this call run behind `requireOrg`. */
export function createApi(deps: ApiDeps = {}) {
  const api = new Hono<ApiEnv>();

  api.use('*', refuseDeviceCredential);
  api.use('*', async (c, next) => {
    c.set('auth', createAuth(c.env, c.req.raw, deps.email ?? emailSenderFor(c.env)));
    await next();
  });

  api.on(['GET', 'POST'], '/auth/*', (c) => c.var.auth.handler(c.req.raw));

  // GitHub is offered only when its OAuth app is configured. In dev, codes are not emailed but
  // printed in the `wrangler dev` terminal (src/email), and the CMS says so.
  api.get('/sign-in-options', (c) =>
    c.json({
      emailCode: true,
      github: Boolean(c.env.GITHUB_CLIENT_ID && c.env.GITHUB_CLIENT_SECRET),
      codesInTerminal: c.env.ENVIRONMENT === 'dev',
    }),
  );

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
  mountTools(api, deps.connectors, deps.email);
  mountConnectionCallback(api, deps.connectors);
  mountBlobs(api);
  return api;
}
