/**
 * `/api`: the CMS's tree. Callers are people with a session cookie; a device credential
 * (`Authorization` header) is refused here, as a session is refused on `/v1/device`.
 *
 * - `/api/auth/*` is Better Auth: email code and GitHub sign-in, organizations, invitations.
 * - `/api/sign-in-options` says which sign-in methods the sign-in page should offer. Public.
 * - `/api/session` says who is signed in and their active org, if any.
 * - Every other route runs behind `requireOrg`, which re-checks membership of the active org
 *   on every request and hands handlers `c.var.org`, a `scoped(db, orgId)`.
 * - A CMS tab names the org it shows in `TAB_ORG_HEADER` (#129). `/api/session`, `requireOrg`
 *   and Better Auth's org calls refuse a call from a tab whose org is no longer the session's:
 *   the member switched org in another tab. Callers with no tab (agents, scripts) send none.
 * - `/api/tools` serves the tool registry (./tools.ts). It is the only route here that changes
 *   data, but for the OAuth callback (./connections.ts), a GET because a provider redirects the
 *   browser to it, which changes data only by running `finish_connection` through the
 *   dispatcher; test/routes.test.ts fails if another one does.
 */
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { findMembership, memberOrgNames, scoped, type OrgScope } from '@signforge/db';
import { createAuth, ROLES, type Auth, type AuthSession, type Role } from '../auth';
import { emailSenderFor, type EmailSender } from '../email';
import type { ConnectorDeps } from '../connectors';
import { mountBlobs } from './blobs';
import { mountConnectionCallback, mountSignedOutCallback } from './connections';
import { ORG_CHANGED, TAB_ORG_HEADER } from './tab-org';
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
 * A 409 when the request comes from a CMS tab showing another org than the session's active one,
 * which the member switched in another tab: acting in the session's org would act on one the tab
 * does not show. The header only ever refuses; the org still comes from the session alone. With no
 * header (an agent, a script, the CLI) there is no tab to be out of date. The message names only
 * orgs the member belongs to, so a made-up header learns nothing.
 */
async function refuseOtherTabOrg(c: Context<ApiEnv>, session: AuthSession): Promise<Response | undefined> {
  const shown = c.req.header(TAB_ORG_HEADER);
  const active = session.session.activeOrganizationId ?? null;
  if (shown === undefined || shown === active) return undefined;
  const names = await memberOrgNames(c.env.DB, session.user.id, active ? [shown, active] : [shown]);
  const tab = names.get(shown) ?? 'another organization';
  const now = active && names.get(active);
  const message = now
    ? `This tab is on ${tab}; you switched to ${now} in another tab. Reload.`
    : `This tab is on ${tab}, which is no longer your active organization. Reload.`;
  return c.json({ error: ORG_CHANGED, message }, 409);
}

/**
 * The session's active org, with membership re-checked against the database. The session (and
 * its cache cookie, for up to five minutes) only says which org is active; whether the user is
 * still a member, and in what role, is read fresh every time. The org comes from the session
 * alone, never from the request, so ids from another org find nothing.
 */
const requireOrg: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const refused = await refuseOtherTabOrg(c, c.var.session);
  if (refused) return refused;
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

  // Better Auth's org calls act on the active org unless told another, so a tab on another org is
  // refused them, but for switching and creating (which switches). Signed out, Better Auth answers.
  api.on(['GET', 'POST'], '/auth/*', async (c) => {
    if (c.req.header(TAB_ORG_HEADER) && /\/organization\/(?!(set-active|create)$)/.test(c.req.path)) {
      const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
      const refused = session && (await refuseOtherTabOrg(c, session));
      if (refused) return refused;
    }
    return c.var.auth.handler(c.req.raw);
  });

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
    const refused = await refuseOtherTabOrg(c, c.var.session);
    if (refused) return refused;
    const { user, session } = c.var.session;
    const orgId = session.activeOrganizationId ?? null;
    const membership = orgId ? await findMembership(c.env.DB, orgId, user.id) : undefined;
    return c.json({
      user: { id: user.id, email: user.email, name: user.name },
      organization: orgId && membership ? { id: orgId, role: membership.role } : null,
    });
  });

  mountSignedOutCallback(api);
  api.use('*', requireSession, requireOrg);
  mountTools(api, deps.connectors, deps.email);
  mountConnectionCallback(api, deps.connectors);
  mountBlobs(api);
  return api;
}
