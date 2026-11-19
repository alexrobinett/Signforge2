/**
 * Connection tools (docs/backend-plan.md, Connectors). A connection is an account an org
 * connected at a provider, which provider data sources read through. A member connects one with
 * OAuth 2.0: `start_connection` gives the provider's authorize URL, with a `state` that only the
 * URL holds and a PKCE challenge; the provider sends the browser back to the API's callback,
 * which runs `finish_connection` with the state and code. The state finds the authorization in
 * the caller's org only, for the member who started it, once, within 10 minutes. The grant is
 * sealed by the API (`Connectors`) and no tool ever returns it.
 */
import type { OrgScope, Staged } from '@signforge/db';
import { z } from 'zod';
import { sha256Hex } from './dispatch';
import { id } from './fields';
import { nextOutput, page, pageInput } from './paging';
import { type Connectors, defineTool, notFound, ToolError } from './tool';

/** How long an authorization waits for its callback. */
const AUTHORIZATION_MS = 10 * 60_000;

const status = z
  .enum(['active', 'needs_reconnect', 'disconnected'])
  .describe(
    'needs_reconnect: the provider refused the grant (revoked or expired), so its sources fail until a person reconnects it; disconnected: its credentials are deleted',
  );

const connectionOutput = z.object({
  id: z.string(),
  provider: z.string(),
  account: z.string().describe('The account, as the provider names it'),
  scopes: z.array(z.string()).describe('What the provider granted'),
  status,
  expiresAt: z.number().nullable().describe('When the current access token runs out (the poller refreshes it before); null for one that does not'),
  lastError: z.string().nullable().describe('Why the provider last refused, as a category (invalid_grant, ...)'),
  createdBy: z.string().describe('The user who first connected it'),
  createdAt: z.number(),
  updatedAt: z.number(),
});

type ConnectionRow = NonNullable<Awaited<ReturnType<OrgScope['connections']['get']>>>;

const viewOf = (c: ConnectionRow): z.infer<typeof connectionOutput> => ({
  id: c.id,
  provider: c.provider,
  account: c.account,
  scopes: z.array(z.string()).parse(JSON.parse(c.scopesJson)),
  status: c.status,
  expiresAt: c.expiresAt,
  lastError: c.lastError,
  createdBy: c.createdBy,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

function connectorsOf(connectors: Connectors | undefined): Connectors {
  if (!connectors) throw new Error('the connection tools need the connectors');
  return connectors;
}

async function requireConnection(org: OrgScope, connectionId: string) {
  const row = await org.connections.get(connectionId);
  if (!row) throw notFound('connection', connectionId);
  return row;
}

/** 32 random bytes, base64url: the `state` of one authorization. */
function newState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const NOT_PENDING = 'no pending authorization has this state: it was finished already, ran out, or was started by someone else. Start again';

const listConnections = defineTool({
  name: 'list_connections',
  description:
    "List the organization's connected accounts (Google, Square, ...), ordered by id, a page at a time, and the providers this deployment can connect. Credentials are never shown. Returns { connections, providers, next }.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ ...pageInput }),
  output: z.object({
    connections: z.array(connectionOutput),
    providers: z.array(z.string()).describe('The providers start_connection takes here'),
    next: nextOutput,
  }),
  example: {},
  handler: async ({ org, input, connectors }) => {
    const { rows, next } = page(await org.connections.list(), (c) => [c.id], input);
    return { connections: rows.map(viewOf), providers: [...connectorsOf(connectors).providers], next };
  },
});

const startConnection = defineTool({
  name: 'start_connection',
  description:
    'Connect an account at a provider, or reconnect one (connectionId) whose grant the provider refused. Returns { authorizeUrl, expiresAt }: send the person to authorizeUrl to sign in at the provider and approve; the provider brings them back to SignForge, which finishes the connection. Only the person who started it can finish it, once, before expiresAt (10 minutes).',
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  input: z.object({
    provider: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,31}$/, 'not a provider name')
      .describe('The provider, such as google'),
    connectionId: id('connection').optional().describe('A connection to authorize again in place, keeping its id and its data sources'),
  }),
  output: z.object({
    authorizationId: z.string(),
    authorizeUrl: z.string().describe("The provider's sign-in and consent page, for this authorization only"),
    expiresAt: z.number(),
  }),
  example: { provider: 'google' },
  target: (input, output) =>
    input.connectionId ? { kind: 'connection', id: input.connectionId } : { kind: 'connection_authorization', id: output.authorizationId },
  handler: async ({ org, actor, input, write, connectors }) => {
    // The provider sends a browser back, and the callback finishes as its session's user: an agent's authorization could never be finished.
    if (actor.kind !== 'user')
      throw new ToolError(
        'forbidden',
        'Only a person signed in to the CMS can connect an account: the provider sends their browser back to SignForge, which finishes it as them. Ask them to connect it on the Integrations page',
      );
    const providers = connectorsOf(connectors);
    if (!providers.providers.includes(input.provider))
      throw new ToolError('invalid_input', `${input.provider} cannot be connected here; this deployment connects: ${providers.providers.join(', ') || 'none'}`);
    if (input.connectionId) {
      const existing = await requireConnection(org, input.connectionId);
      if (existing.provider !== input.provider) throw new ToolError('invalid_input', `connection ${existing.id} is a ${existing.provider} connection`);
    }
    const now = Date.now();
    write(org.connections.authorizations.stage.deleteExpired(now));
    const state = newState();
    const stateHash = await sha256Hex(state);
    const { authorizeUrl, verifierSealed } = await providers.begin(input.provider, { orgId: org.orgId, stateHash }, state);
    const row = write(
      await org.connections.authorizations.stage.insert({
        provider: input.provider,
        connectionId: input.connectionId ?? null,
        stateHash,
        verifierSealed,
        actorKind: actor.kind,
        actorId: actor.id,
        expiresAt: now + AUTHORIZATION_MS,
      }),
    );
    return { authorizationId: row.id, authorizeUrl, expiresAt: row.expiresAt };
  },
});

const finishConnection = defineTool({
  name: 'finish_connection',
  description:
    "Finish an authorization start_connection began, with the state and code the provider sent back (the API's callback route calls this; a person does not). Refused unless the caller started it, in this organization, within 10 minutes, and it was not finished before. Returns { connection }.",
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  input: z.object({
    oauthState: z.string().min(16).max(256).describe('The state the provider sent back'),
    code: z.string().min(1).max(2048).describe("The provider's authorization code"),
  }),
  output: z.object({ connection: connectionOutput }),
  example: { oauthState: 'example-state-from-the-callback', code: 'example-code' },
  // No output when the provider refused the code: the authorization was used up, with nothing to name.
  target: (_input, output: { connection: { id: string } } | undefined) => (output ? { kind: 'connection', id: output.connection.id } : undefined),
  handler: async ({ org, actor, input, write, onDiscard, connectors }) => {
    const providers = connectorsOf(connectors);
    const pending = await org.connections.authorizations.byState(await sha256Hex(input.oauthState), Date.now());
    if (!pending || pending.actorKind !== actor.kind || pending.actorId !== actor.id) throw new ToolError('not_found', NOT_PENDING);
    write(org.connections.authorizations.stage.consume(pending.id));
    // A new connection's id is made when it is staged, for the grant to be sealed to; it is written only once the provider granted it.
    let fresh: Staged<ConnectionRow> | undefined;
    let target: ConnectionRow;
    if (pending.connectionId) target = await requireConnection(org, pending.connectionId);
    else {
      fresh = org.connections.stage.insert({ provider: pending.provider, account: '', scopesJson: '[]', status: 'active', createdBy: actor.id });
      target = fresh.row;
    }
    let grant: Awaited<ReturnType<Connectors['finish']>>;
    try {
      grant = await providers.finish(pending.provider, pending, input.code, { orgId: org.orgId, id: target.id });
    } catch (e) {
      if (!(e instanceof ToolError)) throw e;
      // The state works once, refused or not: commit using it up, audited with the refusal.
      // biome-ignore lint/style/useErrorCause: the cause is passed, in the options argument.
      throw new ToolError(e.code, e.message, e.details, true, { cause: e });
    }
    // Not stored if this call loses (a twin callback for the same state committed first): revoke it then.
    onDiscard(() => providers.revoke(pending.provider, { orgId: org.orgId, id: target.id }, grant.credentialsSealed));
    if (fresh) write(fresh);
    // Its sources failed while it needed reconnecting, backing off for hours: poll them now.
    else write(org.dataSources.stage.pollAgain(target.id));
    const connection = write(
      org.connections.stage.update(target, {
        account: grant.account,
        scopesJson: JSON.stringify(grant.scopes),
        credentialsSealed: grant.credentialsSealed,
        expiresAt: grant.expiresAt,
        status: 'active',
        lastError: null,
      }),
    );
    return { connection: viewOf(connection) };
  },
  // Another finish of the same state committed first.
  refuseFailedCommit: async ({ org, input }) =>
    (await org.connections.authorizations.byState(await sha256Hex(input.oauthState), Date.now())) ? undefined : new ToolError('not_found', NOT_PENDING),
});

const disconnect = defineTool({
  name: 'disconnect',
  description:
    'Disconnect an account: revoke its grant at the provider where the provider allows it, and delete its credentials. A connection no data source reads through is deleted; one that sources still read through is kept as disconnected, so they say why they fail, until they are deleted or it is reconnected. Returns { deleted, dataSourceIds }.',
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  input: z.object({ connectionId: id('connection') }),
  output: z.object({
    deleted: z.boolean().describe('Whether the connection is gone; false while data sources read through it'),
    dataSourceIds: z.array(z.string()).describe('The data sources that read through it, which now fail as disconnected'),
  }),
  example: { connectionId: 'con_example' },
  target: (input) => ({ kind: 'connection', id: input.connectionId }),
  handler: async ({ org, input, write, connectors }) => {
    const row = await requireConnection(org, input.connectionId);
    // Before the batch: a failed batch leaves the grant revoked, and the next poll marks it needs_reconnect.
    if (row.credentialsSealed) await connectorsOf(connectors).revoke(row.provider, { orgId: org.orgId, id: row.id }, row.credentialsSealed);
    const dataSourceIds = (await org.dataSources.usingConnection(row.id)).map((d) => d.id);
    if (dataSourceIds.length) write(org.connections.stage.update(row, { status: 'disconnected', credentialsSealed: null, expiresAt: null, lastError: null }));
    else write(org.connections.stage.delete(row.id));
    return { deleted: !dataSourceIds.length, dataSourceIds };
  },
});

export const connectionTools = [listConnections, startConnection, finishConnection, disconnect];
