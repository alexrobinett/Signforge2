// CPU per request of the parts that run on every call, in Node (V8, as workerd), with no I/O:
//   1. the MCP SDK's stateless handler answering tools/list and tools/call (a fresh Server each);
//   2. building Better Auth with the provider plugin, as the API does per request, and serving
//      its authorization server metadata from an in-memory database.
// The Free plan allows 10 ms of CPU per request. `node scripts/cpu.mjs`
import { cpuUsage } from 'node:process';
import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { authOptions } from '../src/auth.ts';

const RUNS = 500;
async function measure(label, run) {
  for (let i = 0; i < 20; i++) await run(); // warm the JIT, as a warm isolate is
  const start = cpuUsage();
  for (let i = 0; i < RUNS; i++) await run();
  const { user, system } = cpuUsage(start);
  console.log(`${label}: ${((user + system) / 1000 / RUNS).toFixed(2)} ms CPU per request`);
}

const tools = Array.from({ length: 80 }, (_, i) => ({
  name: `tool_${i}`,
  description: 'A tool description of about the length the registry has, a sentence or two that says what it does and when to use it.',
  inputSchema: { type: 'object', properties: { id: { type: 'string' }, ifVersion: { type: 'integer' } }, required: ['id'] },
  annotations: { readOnlyHint: i % 2 === 0 },
}));
const handler = createMcpHandler(
  () => {
    const server = new Server({ name: 'signforge', version: '0' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', () => ({ tools }));
    server.setRequestHandler('tools/call', () => ({ content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } }));
    return server;
  },
  { responseMode: 'json' },
);
const rpc = (method, params) =>
  new Request('http://api.test/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
const authInfo = { token: 't', clientId: 'c', scopes: [] };
const sample = await (await handler.fetch(rpc('tools/list', {}), { authInfo })).text();
if (!sample.includes('tool_79')) throw new Error(`tools/list did not list the tools: ${sample.slice(0, 200)}`);
await measure('MCP tools/list, 80 tools', async () => (await handler.fetch(rpc('tools/list', {}), { authInfo })).text());
await measure('MCP tools/call', async () => (await handler.fetch(rpc('tools/call', { name: 'tool_1', arguments: { id: 'x' } }), { authInfo })).text());

const MODELS = [
  'user',
  'session',
  'account',
  'verification',
  'organization',
  'member',
  'invitation',
  'oauthClient',
  'oauthResource',
  'oauthClientResource',
  'oauthRefreshToken',
  'oauthAccessToken',
  'oauthConsent',
  'oauthClientAssertion',
];
const db = Object.fromEntries(MODELS.map((m) => [m, []]));
const origins = { cms: 'http://cms.test', mcp: 'http://api.test' };
await measure('Better Auth + provider built per request, metadata', async () => {
  const auth = betterAuth({
    ...authOptions(origins, async () => {}),
    database: memoryAdapter(db),
    baseURL: origins.cms,
    secret: 'x'.repeat(32),
    telemetry: { enabled: false },
    logger: { disabled: true },
  });
  return (await oauthProviderAuthServerMetadata(auth)(new Request('http://cms.test/.well-known/oauth-authorization-server/api/auth'))).text();
});
