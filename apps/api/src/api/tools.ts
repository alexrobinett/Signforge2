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
import { describeTools, dispatch, registry, type Caller, type ToolErrorCode } from '@signforge/tools';
import type { Hono } from 'hono';
import { clientIp } from '../device/pairing';
import { screenNotifier } from '../device/screens';
import { feedUrlSealer } from '../data/cipher';
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

export function mountTools(api: Hono<ApiEnv>) {
  api.get('/tools', (c) => c.json({ tools: describeTools(registry, { role: c.var.role }) }));

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
    const caller: Caller = {
      org: c.var.org,
      role: c.var.role,
      actor: { kind: 'user', id: c.var.session.user.id, clientId: CMS_CLIENT_ID },
      blobs: c.env.BLOBS,
      uploads: uploadSigner(c.env, c.req.url),
      feedUrls: feedUrlSealer(c.env),
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
    const result = await dispatch(registry, c.req.param('name'), input, caller);
    if (result.ok) return c.json(result.output as object);
    const { error, message, details } = result;
    return c.json({ error, message, ...(details === undefined ? {} : { details }) }, STATUS[error]);
  });
}
