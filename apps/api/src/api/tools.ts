/**
 * The CMS's door to the tool registry (`@signforge/tools`). Mounted behind `requireOrg`, so the
 * caller is a member of the session's active org, with the role read fresh.
 *
 *   GET  /api/tools         the tools this caller may use: name, description, scope, role, JSON Schema input
 *   POST /api/tools/:name   body: the tool's input as JSON. 200 with the tool's output, or an error
 *
 * Every route that changes data on `/api`, other than Better Auth's, is this one;
 * test/routes.test.ts fails if another appears. See packages/tools/README.md for the contract.
 */
import { describeTools, dispatch, grantOf, registry, type Caller, type ToolErrorCode } from '@signforge/tools';
import type { Context, Hono } from 'hono';
import { type ConnectorDeps, connectorDeps, connectorsFor } from '../connectors';
import { clientIp } from '../device/pairing';
import { screenNotifier } from '../device/screens';
import { alertSecretSealer, feedUrlSealer } from '../data/cipher';
import { deliverAlert } from '../deliveries';
import { emailSenderFor, type EmailSender } from '../email';
import { uploadSigner } from '../uploads';
import type { ApiEnv } from './index';

const STATUS: Record<ToolErrorCode, 400 | 403 | 404 | 409 | 429> = {
  invalid_input: 400,
  forbidden: 403,
  unknown_tool: 404,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
};

/** The CMS's client id in the audit log. */
const CMS_CLIENT_ID = 'cms';

/** The path the providers send the browser back to (./connections.ts), registered with each provider's OAuth client. */
export const CALLBACK_PATH = '/api/connections/callback';

/**
 * The session's member as a tool caller, through the cms client. `email` sends test alerts by
 * email; it defaults to `emailSenderFor(env)`, and tests pass a recorder.
 */
export function cmsCaller(c: Context<ApiEnv>, connectors: ConnectorDeps | undefined, email?: EmailSender): Caller {
  return {
    org: c.var.org,
    role: c.var.role,
    actor: { kind: 'user', id: c.var.session.user.id, clientId: CMS_CLIENT_ID },
    blobs: c.env.BLOBS,
    uploads: uploadSigner(c.env, c.req.url),
    feedUrls: feedUrlSealer(c.env),
    alertSecrets: alertSecretSealer(c.env),
    // After the response: a receiver's 5 seconds are not the caller's to wait for.
    deliveries: {
      now: (id) =>
        c.executionCtx.waitUntil(
          deliverAlert(c.env, email ?? emailSenderFor(c.env), c.var.orgId, id).catch((err: unknown) => console.error('alert delivery failed', err)),
        ),
    },
    connectors: connectorsFor(c.env, connectors ?? connectorDeps(c.env), new URL(CALLBACK_PATH, c.req.url).href),
    screens: screenNotifier(c.env),
    // A claim counts against the member and against the address, so many accounts on one address share a limit.
    rateLimit: async () => {
      const [user, ip] = await Promise.all([
        c.env.PAIR_CLAIM_LIMIT.limit({ key: `user:${c.var.session.user.id}` }),
        c.env.PAIR_CLAIM_LIMIT.limit({ key: `ip:${clientIp(c)}` }),
      ]);
      return user.success && ip.success;
    },
  };
}

export function mountTools(api: Hono<ApiEnv>, connectors: ConnectorDeps | undefined, email?: EmailSender) {
  api.get('/tools', async (c) => c.json({ tools: describeTools(registry, await grantOf({ org: c.var.org, role: c.var.role })) }));

  api.post('/tools/:name', async (c) => {
    // JSON only: a cross-site form cannot send it without a CORS preflight, which this API never grants.
    if (!/^application\/json\b/i.test(c.req.header('content-type') ?? '')) {
      return c.json({ error: 'invalid_input', message: 'send the input as application/json' }, 415);
    }
    const text = await c.req.text();
    let input: unknown = {};
    if (text.trim()) {
      try {
        input = JSON.parse(text);
      } catch {
        return c.json({ error: 'invalid_input', message: 'the body is not JSON' }, 400);
      }
    }
    const result = await dispatch(registry, c.req.param('name'), input, cmsCaller(c, connectors, email));
    if (result.ok) return c.json(result.output as object);
    const { error, message, details } = result;
    return c.json({ error, message, ...(details === undefined ? {} : { details }) }, STATUS[error]);
  });
}
