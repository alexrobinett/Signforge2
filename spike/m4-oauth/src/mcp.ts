/**
 * The resource server: `/mcp` and its protected resource metadata (RFC 9728), on the MCP host.
 *
 * - A request with a session cookie is refused, as `/api` refuses an `Authorization` header, and so
 *   is any request with an `Origin` header (the spec's DNS-rebinding rule: no browser belongs here).
 * - No token, or a token that is not live, gets 401 with `WWW-Authenticate` naming the metadata.
 * - A token is opaque: its SHA-256 is looked up with its grant and the member's role in one D1 read.
 *   It must be unexpired, unrevoked, issued for this resource, and its grant unrevoked, and the
 *   person must still be a member. Scopes are the grant's, capped by the role now.
 * - The MCP SDK's stateless handler answers each POST with JSON: no session, no Durable Object.
 */
import { createMcpHandler, Server, type Tool } from '@modelcontextprotocol/server';
import { OAUTH_SCOPES, ROLE_SCOPES, resourceOf, issuerOf, type Role, type ToolScope } from './auth';

export interface AgentCaller {
  grantId: string;
  clientId: string;
  clientName: string | null;
  orgId: string;
  orgName: string;
  userId: string;
  role: Role;
  scopes: ToolScope[];
}

const origins = (env: Env) => ({ cms: env.CMS_ORIGIN, mcp: env.MCP_ORIGIN });
const metadataUrl = (env: Env) => `${env.MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp`;

export function protectedResourceMetadata(env: Env): Response {
  return Response.json({
    resource: resourceOf(origins(env)),
    authorization_servers: [issuerOf(origins(env))],
    scopes_supported: OAUTH_SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'SignForge (spike)',
  });
}

function challenge(env: Env, error?: 'invalid_token'): Response {
  const parts = [`resource_metadata="${metadataUrl(env)}"`, `scope="${OAUTH_SCOPES.join(' ')}"`];
  if (error) parts.unshift(`error="${error}"`);
  return Response.json({ error: error ?? 'unauthenticated' }, { status: 401, headers: { 'www-authenticate': `Bearer ${parts.join(', ')}` } });
}

async function sha256Base64Url(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...digest))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

interface TokenRow {
  clientId: string;
  clientName: string | null;
  userId: string;
  expiresAt: string;
  revoked: string | null;
  resources: string | null;
  grantId: string;
  orgId: string;
  orgName: string;
  grantScopes: string;
  grantRevokedAt: number | null;
  role: string | null;
}

/** The caller a bearer token stands for now, or undefined if the token or its grant is not live. */
export async function callerOf(env: Env, token: string): Promise<AgentCaller | undefined> {
  const row = await env.DB.prepare(
    `SELECT t.clientId, c.name AS clientName, t.userId, t.expiresAt, t.revoked, t.resources,
            g.id AS grantId, g.org_id AS orgId, o.name AS orgName, g.scopes AS grantScopes, g.revoked_at AS grantRevokedAt, m.role
       FROM oauthAccessToken t
       JOIN spike_grants g ON g.id = t.referenceId
       JOIN organization o ON o.id = g.org_id
       LEFT JOIN member m ON m.organizationId = g.org_id AND m.userId = g.user_id
       LEFT JOIN oauthClient c ON c.clientId = t.clientId
      WHERE t.token = ?`,
  )
    .bind(await sha256Base64Url(token))
    .first<TokenRow>();
  if (!row || row.revoked || row.grantRevokedAt || !row.role) return undefined;
  if (Date.parse(row.expiresAt) <= Date.now()) return undefined;
  const resources: string[] = row.resources ? JSON.parse(row.resources) : [];
  if (!resources.includes(resourceOf(origins(env)))) return undefined;
  const role = row.role as Role;
  const granted: string[] = JSON.parse(row.grantScopes);
  return {
    grantId: row.grantId,
    clientId: row.clientId,
    clientName: row.clientName,
    orgId: row.orgId,
    orgName: row.orgName,
    userId: row.userId,
    role,
    scopes: ROLE_SCOPES[role].filter((s) => granted.includes(s)),
  };
}

interface StubTool extends Pick<Tool, 'name' | 'description' | 'inputSchema' | 'annotations'> {
  scope: ToolScope;
  run: (caller: AgentCaller, input: Record<string, unknown>) => Record<string, unknown>;
}

/** Two stub tools: one read, one write, so `tools/list` shows the grant's filter. */
const TOOLS: StubTool[] = [
  {
    name: 'whoami',
    scope: 'content:read',
    description: 'Which organization, role and scopes this connection has.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: (c: AgentCaller) => ({ org: { id: c.orgId, name: c.orgName }, role: c.role, scopes: c.scopes, grantId: c.grantId, clientId: c.clientId }),
  },
  {
    name: 'draft_note',
    scope: 'content:draft',
    description: 'A stub write: echoes the note back. Changes nothing.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 200 } }, required: ['text'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: (_c: AgentCaller, input: Record<string, unknown>) => ({ drafted: String(input.text) }),
  },
];

const handler = createMcpHandler(
  ({ authInfo }) => {
    const caller = authInfo?.extra?.caller as AgentCaller;
    const server = new Server(
      { name: 'signforge-spike', version: '0.0.0' },
      { capabilities: { tools: {} }, instructions: 'SignForge spike: whoami says which org this connection works in.' },
    );
    const allowed = TOOLS.filter((t) => caller.scopes.includes(t.scope));
    server.setRequestHandler('tools/list', () => ({
      tools: allowed.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })),
    }));
    server.setRequestHandler('tools/call', (request) => {
      const tool = allowed.find((t) => t.name === request.params.name);
      if (!tool) return { isError: true, content: [{ type: 'text', text: `forbidden: no tool ${request.params.name} for this grant` }] };
      const output = tool.run(caller, request.params.arguments ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
    });
    return server;
  },
  { responseMode: 'json', maxRequestBodySize: 64 * 1024 },
);

const SESSION_COOKIE = /(?:^|;\s*)(?:__Secure-)?better-auth\./;

export async function serveMcp(request: Request, env: Env): Promise<Response> {
  if (SESSION_COOKIE.test(request.headers.get('cookie') ?? '')) return Response.json({ error: 'session_not_accepted' }, { status: 401 });
  if (request.headers.has('origin')) return Response.json({ error: 'origin_not_accepted' }, { status: 403 });
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '');
  if (!match?.[1]) return challenge(env);
  const caller = await callerOf(env, match[1]);
  if (!caller) return challenge(env, 'invalid_token');
  return handler.fetch(request, {
    authInfo: { token: match[1], clientId: caller.clientId, scopes: caller.scopes, resource: new URL(resourceOf(origins(env))), extra: { caller } },
  });
}
