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
import type { ConnectorDeps } from '../connectors';
import type { EmailSender } from '../email';
import { publishLock } from '../publish';
import { toolServices } from '../tool-services';
import type { ApiEnv } from './index';

export const STATUS: Record<ToolErrorCode, 400 | 403 | 404 | 409 | 429 | 503> = {
  invalid_input: 400,
  forbidden: 403,
  unknown_tool: 404,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  unavailable: 503,
};

/** The CMS's client id in the audit log. */
const CMS_CLIENT_ID = 'cms';

/**
 * The session's member as a tool caller, through the cms client, with every tool service. `email`
 * and `connectors` are the tests' seams (`ServiceScope`).
 */
export function cmsCaller(c: Context<ApiEnv>, connectors: ConnectorDeps | undefined, email?: EmailSender): Caller {
  return {
    org: c.var.org,
    role: c.var.role,
    actor: { kind: 'user', id: c.var.session.user.id, clientId: CMS_CLIENT_ID },
    blobs: c.env.BLOBS,
    services: toolServices(c, { orgId: c.var.org.orgId, member: c.var.session.user.id, email, connectors, auth: c.var.auth }),
    publishLock: publishLock(c.env, c.var.org.orgId),
    member: c.var.session.user.id,
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
