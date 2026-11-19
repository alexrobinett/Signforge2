/**
 * `GET /api/connections/callback`: where a provider sends the browser back after a member
 * approved, or refused, a connection (RFC 6749 4.1.2). Behind `requireOrg`, so it acts as the
 * session's member in their active org, and it changes data only by running `finish_connection`
 * through the dispatcher, which finds the authorization by its `state` in that org, for that
 * member, once. A GET because the provider redirects to it; the browser carries the session
 * cookie (SameSite=Lax) on that top-level navigation.
 *
 * It then sends the browser to the CMS's Integrations page (#80): `?connected=<connectionId>`,
 * or `?connectionError=<code>` (`denied` when the person refused at the provider, `provider` for
 * another error the provider sent, else the tool's refusal: `not_found`, `invalid_input`, ...).
 *
 * A signed-out browser goes to `/integrations?connectionError=signed_out`, carrying neither code
 * nor state, instead of the 401 JSON every other `/api` route answers: nothing is used up, and the
 * member can sign in and finish it from the same consent within its 10 minutes.
 */
import { dispatch, registry } from '@signforge/tools';
import type { Context, Hono } from 'hono';
import type { ConnectorDeps } from '../connectors';
import type { ApiEnv } from './index';
import { CALLBACK_PATH, cmsCaller } from './tools';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const integrations = (c: Context<ApiEnv>, params: Record<string, string>) =>
  c.redirect(`${c.env.CMS_ORIGIN ?? ''}/integrations?${new URLSearchParams(params)}`, 303);

/** Before the session check: a signed-out browser goes to the Integrations page, which sends it to sign-in. */
export function mountSignedOutCallback(api: Hono<ApiEnv>) {
  api.get(CALLBACK_PATH.slice('/api'.length), async (c, next) => {
    if (await c.var.auth.api.getSession({ headers: c.req.raw.headers })) return next();
    return integrations(c, { connectionError: 'signed_out' });
  });
}

export function mountConnectionCallback(api: Hono<ApiEnv>, connectors: ConnectorDeps | undefined) {
  api.get(CALLBACK_PATH.slice('/api'.length), async (c) => {
    const back = (params: Record<string, string>) => integrations(c, params);
    const { state = '', code = '', error } = c.req.query();
    if (error) return back({ connectionError: error === 'access_denied' ? 'denied' : 'provider' });
    const result = await dispatch(registry, 'finish_connection', { oauthState: state, code }, cmsCaller(c, connectors));
    if (!result.ok) return back({ connectionError: result.error });
    const { output } = result;
    if (!isObject(output) || !isObject(output.connection) || typeof output.connection.id !== 'string')
      throw new Error('finish_connection returned no connection');
    return back({ connected: output.connection.id });
  });
}
