// Connectors (#83): the OAuth round trip through the real routes against a fake provider
// (test/fake-provider.ts), credentials sealed at rest and never shown or audited, refresh,
// revoke on disconnect, and provider data sources polled through their adapter.
import { scoped } from '@signforge/db';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProviderError, type ProviderFetch, providerFetch } from '../src/connectors/adapter';
import { oauth2 } from '../src/connectors/oauth';
import { openGrant, sealGrant } from '../src/connectors/vault';
import { pollDataSources, REFRESH_MARGIN_MS } from '../src/data/poller';
import { Client, email, testApp } from './client';
import { fakeProvider } from './fake-provider';

const fake = fakeProvider();
const t = testApp({ connectors: { adapters: [fake.adapter], fetch: fake.fetch } });
const owner = new Client(t);
const stranger = new Client(t);
let orgId: string;

const json = async (res: Response) => {
  const text = await res.text();
  expect(res.status, text).toBe(200);
  return JSON.parse(text);
};

/** Through the provider's consent page and back to the callback; returns the callback's redirect. */
async function connect(who: Client, input: { provider: string; connectionId?: string } = { provider: 'fake' }) {
  const { authorizeUrl } = await json(await who.tool('start_connection', input));
  const back = fake.consent(authorizeUrl);
  const res = await who.get(`${back.pathname}${back.search}`);
  expect(res.status).toBe(303);
  return new URL(res.headers.get('location') ?? '', 'https://api.test');
}

const connectionIdOf = async (who: Client) => (await connect(who)).searchParams.get('connected') ?? '';

/** Everything SignForge stores or shows about this org that a token could leak into. */
async function everythingShown(who: Client, id: string) {
  const org = scoped(env.DB, id);
  return JSON.stringify([
    await json(await who.tool('list_connections', {})),
    await json(await who.tool('list_data_sources', {})),
    await org.auditLog.list({ limit: 500 }),
    await org.connections.list(),
    await org.connections.authorizations.list(),
  ]);
}

beforeAll(async () => {
  await owner.signIn(email('connector-owner'));
  orgId = (await owner.createOrg('Connectors')).id;
  await stranger.signIn(email('connector-stranger'));
  await stranger.createOrg('Elsewhere');
});

describe('connecting an account', () => {
  it('sends the person to the provider with a state and an S256 PKCE challenge, and back through the callback', async () => {
    const { authorizeUrl } = await json(await owner.tool('start_connection', { provider: 'fake' }));
    const p = new URL(authorizeUrl).searchParams;
    expect(Object.fromEntries(p)).toMatchObject({
      response_type: 'code',
      client_id: 'signforge-client',
      redirect_uri: 'https://api.test/api/connections/callback',
      scope: 'calendar.read',
      code_challenge_method: 'S256',
    });
    expect(p.get('state')).toMatch(/^[\w-]{43}$/);
    expect(p.get('code_challenge')).toMatch(/^[\w-]{43}$/);

    const back = fake.consent(authorizeUrl);
    const res = await owner.get(`${back.pathname}${back.search}`);
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get('location') ?? '', 'https://api.test');
    expect(location.pathname).toBe('/integrations');
    const id = location.searchParams.get('connected') ?? '';
    // The fake provider checked the verifier against the challenge before it granted.
    expect(fake.requests.some((r) => r.grantType === 'authorization_code')).toBe(true);

    const { connections } = await json(await owner.tool('list_connections', {}));
    expect(connections).toEqual([
      expect.objectContaining({
        id,
        provider: 'fake',
        account: 'facilities@example.test',
        scopes: ['calendar.read'],
        status: 'active',
        expiresAt: expect.any(Number),
      }),
    ]);
  });

  it('seals the tokens, bound to the org and connection, and never shows or audits one', async () => {
    const id = await connectionIdOf(owner);
    const row = await scoped(env.DB, orgId).connections.get(id);
    const grant = await openGrant(env, { orgId, id }, row?.credentialsSealed ?? '');
    expect(grant).toMatchObject({ accessToken: expect.stringMatching(/^fake-access-/), refreshToken: expect.stringMatching(/^fake-refresh-/) });
    expect(await openGrant(env, { orgId, id: 'con_other' }, row?.credentialsSealed ?? '')).toBeUndefined();
    expect(await openGrant(env, { orgId: 'org-other', id }, row?.credentialsSealed ?? '')).toBeUndefined();

    const shown = await everythingShown(owner, orgId);
    expect(shown).toContain('finish_connection');
    for (const token of fake.issuedTokens()) expect(shown, 'a token leaked').not.toContain(token);
  });

  it('refuses a replayed callback', async () => {
    const { authorizeUrl } = await json(await owner.tool('start_connection', { provider: 'fake' }));
    const back = fake.consent(authorizeUrl);
    const first = await owner.get(`${back.pathname}${back.search}`);
    expect(new URL(first.headers.get('location') ?? '', 'https://x').searchParams.get('connected')).toMatch(/^con_/);
    const replay = await owner.get(`${back.pathname}${back.search}`);
    expect(new URL(replay.headers.get('location') ?? '', 'https://x').searchParams.get('connectionError')).toBe('not_found');
  });

  it("refuses a callback for another org's authorization, which its member can still finish", async () => {
    const { authorizeUrl } = await json(await owner.tool('start_connection', { provider: 'fake' }));
    const back = fake.consent(authorizeUrl);
    const before = (await scoped(env.DB, orgId).connections.list()).length;
    const wrong = await stranger.get(`${back.pathname}${back.search}`);
    expect(new URL(wrong.headers.get('location') ?? '', 'https://x').searchParams.get('connectionError')).toBe('not_found');
    const right = await owner.get(`${back.pathname}${back.search}`);
    expect(new URL(right.headers.get('location') ?? '', 'https://x').searchParams.get('connected')).toMatch(/^con_/);
    expect((await scoped(env.DB, orgId).connections.list()).length).toBe(before + 1);
  });

  it('refuses a code issued for another PKCE challenge (an attacker swapping in their own code)', async () => {
    const { authorizeUrl } = await json(await owner.tool('start_connection', { provider: 'fake' }));
    const back = fake.consent(authorizeUrl, { challenge: 'a-challenge-from-another-authorization' });
    const res = await owner.get(`${back.pathname}${back.search}`);
    expect(new URL(res.headers.get('location') ?? '', 'https://x').searchParams.get('connectionError')).toBe('invalid_input');
  });

  it('says so when the person refused at the provider', async () => {
    const res = await owner.get('/api/connections/callback?error=access_denied&state=whatever');
    expect(new URL(res.headers.get('location') ?? '', 'https://x').searchParams.get('connectionError')).toBe('denied');
  });

  it('revokes the grant at the provider on disconnect, and deletes the credentials', async () => {
    const id = await connectionIdOf(owner);
    const row = await scoped(env.DB, orgId).connections.get(id);
    const grant = await openGrant(env, { orgId, id }, row?.credentialsSealed ?? '');
    expect(fake.liveRefreshTokens()).toContain(grant?.refreshToken);
    expect(await json(await owner.tool('disconnect', { connectionId: id }))).toEqual({ deleted: true, dataSourceIds: [] });
    expect(fake.liveRefreshTokens()).not.toContain(grant?.refreshToken);
    expect(await scoped(env.DB, orgId).connections.get(id)).toBeUndefined();
  });
});

describe('provider requests', () => {
  const hosts = { hosts: ['api.provider.test'] };
  const reached: string[] = [];
  const base: typeof fetch = async (input) => {
    reached.push(new Request(input).url);
    return new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } });
  };

  it("go only to the adapter's hosts, over https on the default port, and follow no redirect", async () => {
    const http = providerFetch(hosts, base);
    for (const url of ['https://elsewhere.test/x', 'http://api.provider.test/x', 'https://api.provider.test:8443/x', 'https://u:p@api.provider.test/x'])
      await expect(http(url), url).rejects.toMatchObject({ code: 'host-not-allowed' });
    expect(reached).toEqual([]);
    await expect(http('https://api.provider.test/x')).rejects.toBeInstanceOf(ProviderError);
    await expect(http('https://api.provider.test/x')).rejects.toMatchObject({ code: 'redirect' });
    expect(reached).toEqual(['https://api.provider.test/x', 'https://api.provider.test/x']);
  });
});

describe('a token answer', () => {
  const client = oauth2({
    authorizeEndpoint: 'https://a.test/authorize',
    tokenEndpoint: 'https://a.test/token',
    clientId: 'c',
    clientSecret: 's',
    scopes: ['read'],
  });
  const answering =
    (body: unknown): ProviderFetch =>
    async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const exchange = (body: unknown) => client.exchange({ code: 'c', codeVerifier: 'v', redirectUri: 'https://api.test/cb' }, answering(body), 1_000);

  it('takes expires_in as a number or a numeric string, and refuses anything else', async () => {
    const base = { access_token: 'a', token_type: 'Bearer' };
    expect((await exchange({ ...base, expires_in: 3600 })).grant.expiresAt).toBe(1_000 + 3_600_000);
    expect((await exchange({ ...base, expires_in: '3600' })).grant.expiresAt).toBe(1_000 + 3_600_000);
    expect((await exchange(base)).grant.expiresAt).toBeNull();
    for (const expires_in of ['soon', '', -5, '1e3'])
      await expect(exchange({ ...base, expires_in }), String(expires_in)).rejects.toMatchObject({ code: 'malformed' });
  });
});

describe('a provider data source', () => {
  let connectionId: string;
  let expiresAt: number;
  const org = () => scoped(env.DB, orgId);
  const poll = (now: number, f = fake) => pollDataSources(env, { now, connectors: { adapters: [f.adapter], fetch: f.fetch } });
  const due = (id: string) => org().dataSources.update(id, { nextPollAt: 0 });
  const tokenRequests = () => fake.requests.filter((r) => r.grantType === 'refresh_token').length;

  beforeAll(async () => {
    connectionId = await connectionIdOf(owner);
    expiresAt = (await org().connections.get(connectionId))?.expiresAt ?? 0;
    for (const id of ['rooms-a', 'rooms-b'])
      await json(await owner.tool('create_data_source', { id, name: id, format: 'provider', connectionId, resource: 'rooms' }));
  });

  it('polls through its adapter into a snapshot', async () => {
    await poll(expiresAt - 30 * 60_000);
    expect(JSON.parse((await org().dataSources.snapshot('rooms-a'))?.dataJson ?? 'null')).toEqual({ events: [{ title: 'Standup' }] });
    expect(await org().dataSources.get('rooms-a')).toMatchObject({ failures: 0, lastError: null });
    expect(tokenRequests()).toBe(0);
  });

  it('refreshes a grant about to run out, once for the sources that share it, and stores it sealed', async () => {
    const before = (await org().connections.get(connectionId))?.credentialsSealed;
    fake.resources.set('rooms', { events: [{ title: 'Review' }] });
    await due('rooms-a');
    await due('rooms-b');
    await poll(expiresAt - REFRESH_MARGIN_MS + 1000);
    expect(tokenRequests()).toBe(1);
    const row = await org().connections.get(connectionId);
    expect(row?.credentialsSealed).not.toBe(before);
    expect(row?.expiresAt).toBeGreaterThan(expiresAt);
    for (const id of ['rooms-a', 'rooms-b'])
      expect(JSON.parse((await org().dataSources.snapshot(id))?.dataJson ?? 'null')).toEqual({ events: [{ title: 'Review' }] });
    for (const token of fake.issuedTokens()) expect(await everythingShown(owner, orgId)).not.toContain(token);
    expiresAt = row?.expiresAt ?? 0;
  });

  it('refreshes once when the provider refuses an access token early, and carries on', async () => {
    const refreshes = tokenRequests();
    fake.expireAccessTokens();
    await due('rooms-a');
    await poll(expiresAt - 30 * 60_000);
    expect(tokenRequests()).toBe(refreshes + 1);
    expect(await org().dataSources.get('rooms-a')).toMatchObject({ failures: 0, lastError: null });
  });

  it('marks the connection needs_reconnect when the grant is revoked, and stops asking the provider', async () => {
    fake.revokeAll();
    await due('rooms-a');
    await due('rooms-b');
    await poll(expiresAt + 60_000);
    expect(await org().connections.get(connectionId)).toMatchObject({ status: 'needs_reconnect', lastError: 'invalid_grant' });
    for (const id of ['rooms-a', 'rooms-b']) expect(await org().dataSources.get(id)).toMatchObject({ failures: 1, lastError: 'needs-reconnect' });
    // The last good snapshot stays.
    expect(JSON.parse((await org().dataSources.snapshot('rooms-a'))?.dataJson ?? 'null')).toEqual({ events: [{ title: 'Review' }] });

    const asked = fake.requests.length;
    await due('rooms-a');
    await poll(expiresAt + 10 * 60_000);
    expect(fake.requests.length).toBe(asked);
    expect(await org().dataSources.get('rooms-a')).toMatchObject({ failures: 2, lastError: 'needs-reconnect' });
  });

  it('reads again once reconnected in place: its sources are polled at once, their backoff gone', async () => {
    // Backed off by the failed polls: not due for a while yet.
    for (const id of ['rooms-a', 'rooms-b']) expect((await org().dataSources.get(id))?.nextPollAt).toBeGreaterThan(Date.now());
    const back = await connect(owner, { provider: 'fake', connectionId });
    expect(back.searchParams.get('connected')).toBe(connectionId);
    expect(await org().connections.get(connectionId)).toMatchObject({ status: 'active', lastError: null });
    for (const id of ['rooms-a', 'rooms-b']) expect(await org().dataSources.get(id)).toMatchObject({ nextPollAt: 0, failures: 0, lastError: null });
    fake.resources.set('rooms', { events: [{ title: 'Retro' }] });
    await poll(Date.now());
    for (const id of ['rooms-a', 'rooms-b']) {
      expect(await org().dataSources.get(id)).toMatchObject({ failures: 0, lastError: null });
      expect(JSON.parse((await org().dataSources.snapshot(id))?.dataJson ?? 'null')).toEqual({ events: [{ title: 'Retro' }] });
    }
  });

  it('uses the grant another run refreshed when a rotating provider refuses the old refresh token', async () => {
    const rotating = fakeProvider({ rotateRefreshTokens: true });
    const who = new Client(testApp({ connectors: { adapters: [rotating.adapter], fetch: rotating.fetch } }));
    await who.signIn(email('rotating'));
    const id = (await who.createOrg('Rotating')).id;
    const o = scoped(env.DB, id);
    const { authorizeUrl } = await json(await who.tool('start_connection', { provider: 'fake' }));
    const back = rotating.consent(authorizeUrl);
    const conn = new URL((await who.get(`${back.pathname}${back.search}`)).headers.get('location') ?? '', 'https://x').searchParams.get('connected') ?? '';
    await json(await who.tool('create_data_source', { id: 'rot', name: 'rot', format: 'provider', connectionId: conn, resource: 'rooms' }));
    const expiry = (await o.connections.get(conn))?.expiresAt ?? 0;

    // Only this source is due.
    for (const other of ['rooms-a', 'rooms-b']) await org().dataSources.update(other, { nextPollAt: Number.MAX_SAFE_INTEGER });
    const row = await o.connections.get(conn);
    const held = await openGrant(env, { orgId: id, id: conn }, row?.credentialsSealed ?? '');
    if (!held?.refreshToken || !row?.credentialsSealed) throw new Error('no grant to race with');
    const stored = row.credentialsSealed;

    // While this run's refresh is on its way, another run refreshes and stores its grant, rotating the refresh token out.
    let raced = false;
    const racing: typeof fetch = async (input, init) => {
      const req = new Request(input, init);
      if (!raced && new URLSearchParams(await req.clone().text()).get('refresh_token') === held.refreshToken) {
        raced = true;
        const fresh = await rotating.adapter.refresh(held, providerFetch(rotating.adapter, rotating.fetch), Date.now());
        await o.connections.saveGrant(conn, stored, { credentialsSealed: await sealGrant(env, { orgId: id, id: conn }, fresh), expiresAt: fresh.expiresAt });
      }
      return rotating.fetch(req);
    };
    await pollDataSources(env, { now: expiry + 60_000, connectors: { adapters: [rotating.adapter], fetch: racing } });
    expect(raced).toBe(true);
    expect(await o.connections.get(conn)).toMatchObject({ status: 'active', lastError: null });
    expect(await o.dataSources.get('rot')).toMatchObject({ failures: 0, lastError: null });
  });

  it('stores the second refresh of a run over the first, keeping the rotated refresh token', async () => {
    const rotating = fakeProvider({ rotateRefreshTokens: true });
    const who = new Client(testApp({ connectors: { adapters: [rotating.adapter], fetch: rotating.fetch } }));
    await who.signIn(email('twice'));
    const id = (await who.createOrg('Twice')).id;
    const o = scoped(env.DB, id);
    const { authorizeUrl } = await json(await who.tool('start_connection', { provider: 'fake' }));
    const back = rotating.consent(authorizeUrl);
    const conn = new URL((await who.get(`${back.pathname}${back.search}`)).headers.get('location') ?? '', 'https://x').searchParams.get('connected') ?? '';
    await json(await who.tool('create_data_source', { id: 'twice', name: 'twice', format: 'provider', connectionId: conn, resource: 'rooms' }));
    const expiry = (await o.connections.get(conn))?.expiresAt ?? 0;
    for (const other of ['rooms-a', 'rooms-b']) await org().dataSources.update(other, { nextPollAt: Number.MAX_SAFE_INTEGER });

    // The access token the first refresh brings is refused at once: the run refreshes a second time.
    let refreshes = 0;
    const refusingOnce: typeof fetch = async (input, init) => {
      const req = new Request(input, init);
      const isRefresh = new URLSearchParams(await req.clone().text()).get('grant_type') === 'refresh_token';
      const res = await rotating.fetch(req);
      if (isRefresh && ++refreshes === 1) rotating.expireAccessTokens();
      return res;
    };
    await pollDataSources(env, { now: expiry - REFRESH_MARGIN_MS + 1000, connectors: { adapters: [rotating.adapter], fetch: refusingOnce } });
    expect(refreshes).toBe(2);
    expect(await o.dataSources.get('twice')).toMatchObject({ failures: 0, lastError: null });
    const row = await o.connections.get(conn);
    const stored = await openGrant(env, { orgId: id, id: conn }, row?.credentialsSealed ?? '');
    expect(rotating.liveRefreshTokens()).toContain(stored?.refreshToken);
  });
});
