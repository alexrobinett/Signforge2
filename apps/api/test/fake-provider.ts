/**
 * A fake OAuth 2.0 provider for the connector tests: an authorization server (token and
 * revocation endpoints) and a resource API, answered in memory by `fetch`, and its adapter, built
 * on the API's own OAuth client (src/connectors/oauth.ts) as a real provider's would be. It checks
 * what a real one checks: the client's credentials, that a code is used once, by the redirect URI
 * it was issued for, with the PKCE verifier whose S256 is the challenge it was issued with.
 */
import { type ProviderAdapter, ProviderError } from '../src/connectors/adapter';
import { oauth2 } from '../src/connectors/oauth';

const AUTH = 'auth.fake-provider.test';
const API = 'api.fake-provider.test';
const CLIENT = { id: 'signforge-client', secret: 'client-secret' };
const SCOPE = 'calendar.read';

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const s256 = async (v: string) => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function fakeProvider({ rotateRefreshTokens = false }: { rotateRefreshTokens?: boolean } = {}) {
  let n = 0;
  const codes = new Map<string, { challenge: string; redirectUri: string; account: string }>();
  const refreshTokens = new Map<string, { account: string; live: boolean }>();
  const accessTokens = new Map<string, { account: string; refresh: string; live: boolean }>();
  /** Every request the provider got, for the tests to look at. */
  const requests: { url: string; grantType?: string }[] = [];
  /** What each resource holds. */
  const resources = new Map<string, unknown>([['rooms', { events: [{ title: 'Standup' }] }]]);

  const issue = (account: string, refresh: string) => {
    const access = `fake-access-${++n}-${crypto.randomUUID()}`;
    accessTokens.set(access, { account, refresh, live: true });
    return access;
  };
  const bearer = (req: Request) => {
    const token = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    const t = accessTokens.get(token);
    return t?.live && refreshTokens.get(t.refresh)?.live ? t : undefined;
  };

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const form = req.method === 'POST' ? new URLSearchParams(await req.text()) : new URLSearchParams();
    requests.push({ url: req.url, grantType: form.get('grant_type') ?? undefined });
    if (url.host === AUTH) {
      if (req.headers.get('authorization') !== `Basic ${btoa(`${CLIENT.id}:${CLIENT.secret}`)}`) return json({ error: 'invalid_client' }, 401);
      if (url.pathname === '/token' && form.get('grant_type') === 'authorization_code') {
        const code = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        if (!code || code.redirectUri !== form.get('redirect_uri') || code.challenge !== (await s256(form.get('code_verifier') ?? '')))
          return json({ error: 'invalid_grant' }, 400);
        const refresh = `fake-refresh-${++n}-${crypto.randomUUID()}`;
        refreshTokens.set(refresh, { account: code.account, live: true });
        return json({ access_token: issue(code.account, refresh), token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: SCOPE });
      }
      if (url.pathname === '/token' && form.get('grant_type') === 'refresh_token') {
        const old = form.get('refresh_token') ?? '';
        const r = refreshTokens.get(old);
        if (!r?.live) return json({ error: 'invalid_grant' }, 400);
        let refresh = old;
        if (rotateRefreshTokens) {
          r.live = false;
          refresh = `fake-refresh-${++n}-${crypto.randomUUID()}`;
          refreshTokens.set(refresh, { account: r.account, live: true });
        }
        return json({
          access_token: issue(r.account, refresh),
          token_type: 'Bearer',
          expires_in: 3600,
          ...(rotateRefreshTokens ? { refresh_token: refresh } : {}),
        });
      }
      if (url.pathname === '/revoke') {
        const r = refreshTokens.get(form.get('token') ?? '');
        if (r) r.live = false;
        return new Response(null, { status: 200 });
      }
    }
    if (url.host === API) {
      const who = bearer(req);
      if (!who) return json({ error: 'invalid_token' }, 401);
      if (url.pathname === '/v1/me') return json({ email: who.account });
      const id = decodeURIComponent(url.pathname.replace(/^\/v1\/resources\//, ''));
      if (resources.has(id)) return json(resources.get(id));
    }
    return json({ error: 'not_found' }, 404);
  };

  const client = oauth2({
    authorizeEndpoint: `https://${AUTH}/authorize`,
    tokenEndpoint: `https://${AUTH}/token`,
    revokeEndpoint: `https://${AUTH}/revoke`,
    clientId: CLIENT.id,
    clientSecret: CLIENT.secret,
    scopes: [SCOPE],
  });
  const adapter: ProviderAdapter = {
    provider: 'fake',
    hosts: [AUTH, API],
    authorizeUrl: client.authorizeUrl,
    refresh: client.refresh,
    revoke: client.revoke,
    exchange: async (a, http, now) => {
      const { grant, scopes } = await client.exchange(a, http, now);
      const me = await http(`https://${API}/v1/me`, { headers: { authorization: `Bearer ${grant.accessToken}` } });
      const { email }: { email: string } = await me.json();
      return { grant, scopes, account: email };
    },
    fetch: async (resource, grant, http) => {
      const res = await http(`https://${API}/v1/resources/${encodeURIComponent(resource)}`, { headers: { authorization: `Bearer ${grant.accessToken}` } });
      if (res.status === 401) throw new ProviderError('unauthorized', 'the provider refused the access token');
      if (!res.ok) throw new ProviderError('http-status', `the provider answered ${res.status}`);
      return res.json();
    },
  };

  return {
    adapter,
    fetch,
    requests,
    resources,
    /**
     * A person approving at the provider's authorize page: checks what the page would, and returns
     * where the provider sends the browser back, with a code bound to the PKCE challenge.
     */
    consent(authorizeUrl: string, { account = 'facilities@example.test', challenge }: { account?: string; challenge?: string } = {}) {
      const u = new URL(authorizeUrl);
      const p = u.searchParams;
      if (u.host !== AUTH || p.get('response_type') !== 'code' || p.get('client_id') !== CLIENT.id || p.get('code_challenge_method') !== 'S256')
        throw new Error(`not an authorize URL the fake provider accepts: ${authorizeUrl}`);
      const code = `code-${++n}`;
      const redirectUri = p.get('redirect_uri') ?? '';
      codes.set(code, { challenge: challenge ?? p.get('code_challenge') ?? '', redirectUri, account });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', p.get('state') ?? '');
      return back;
    },
    /** The person revoked SignForge's access at the provider: every token stops working, refresh tokens too. */
    revokeAll() {
      for (const r of refreshTokens.values()) r.live = false;
    },
    /** Access tokens stop working before their time; refresh tokens still work. */
    expireAccessTokens() {
      for (const t of accessTokens.values()) t.live = false;
    },
    /** Which refresh tokens are still good. */
    liveRefreshTokens: () => [...refreshTokens].filter(([, r]) => r.live).map(([t]) => t),
    /** Every token the provider issued, to look for in what SignForge stores and shows. */
    issuedTokens: () => [...accessTokens.keys(), ...refreshTokens.keys()],
  };
}
