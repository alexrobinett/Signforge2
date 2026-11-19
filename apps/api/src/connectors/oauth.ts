/**
 * The one OAuth 2.0 client the provider adapters share: the authorization code grant (RFC 6749
 * 4.1) with PKCE, S256 (RFC 7636), refresh (RFC 6749 6) and revocation (RFC 7009), as a
 * confidential client authenticating with HTTP Basic (RFC 6749 2.3.1). Followed as written in
 * those RFCs and the OAuth 2.0 Security BCP (RFC 9700, January 2025); a provider that departs
 * from them says so in its adapter.
 */
import { type Grant, ProviderError, type ProviderFetch } from './adapter';

export interface OAuthClient {
  authorizeEndpoint: string;
  tokenEndpoint: string;
  /** RFC 7009's endpoint; absent for a provider without one. */
  revokeEndpoint?: string;
  clientId: string;
  clientSecret: string;
  scopes: readonly string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** A token endpoint's success answer (RFC 6749 5.1), or `malformed`. */
function tokenAnswer(body: unknown): { accessToken: string; refreshToken: string | null; expiresIn: number | null; scope: string | null } {
  if (!isObject(body)) throw new ProviderError('malformed', 'the token answer is not a JSON object');
  const { access_token, token_type, refresh_token, expires_in, scope } = body;
  if (typeof access_token !== 'string' || !access_token) throw new ProviderError('malformed', 'the token answer has no access token');
  if (typeof token_type !== 'string' || token_type.toLowerCase() !== 'bearer') throw new ProviderError('malformed', 'the token answer is not a bearer token');
  return {
    accessToken: access_token,
    refreshToken: typeof refresh_token === 'string' && refresh_token ? refresh_token : null,
    expiresIn: typeof expires_in === 'number' && expires_in > 0 ? expires_in : null,
    scope: typeof scope === 'string' ? scope : null,
  };
}

/** An OAuth client for one provider. */
export function oauth2(client: OAuthClient) {
  // RFC 6749 2.3.1: each part form-urlencoded, then Basic.
  const formEncoded = (v: string) => new URLSearchParams([['', v]]).toString().slice(1);
  const basic = `Basic ${btoa(`${formEncoded(client.clientId)}:${formEncoded(client.clientSecret)}`)}`;
  const post = (http: ProviderFetch, url: string, form: Record<string, string>) =>
    http(url, {
      method: 'POST',
      headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form),
    });
  const token = async (http: ProviderFetch, form: Record<string, string>) => {
    const res = await post(http, client.tokenEndpoint, form);
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      // RFC 6749 5.2: invalid_grant is a code or refresh token that is invalid, expired or revoked.
      if (isObject(body) && body.error === 'invalid_grant') throw new ProviderError('invalid_grant', 'the provider refused the grant');
      throw new ProviderError('http-status', `the token endpoint answered ${res.status}`);
    }
    return tokenAnswer(body);
  };
  const expiry = (expiresIn: number | null, now: number) => (expiresIn === null ? null : now + expiresIn * 1000);

  return {
    authorizeUrl({ state, codeChallenge, redirectUri }: { state: string; codeChallenge: string; redirectUri: string }): string {
      const url = new URL(client.authorizeEndpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', client.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('scope', client.scopes.join(' '));
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      return url.href;
    },

    /** The grant for a code, and the scopes granted: the answer's `scope`, else what was asked (RFC 6749 5.1). */
    async exchange({ code, codeVerifier, redirectUri }: { code: string; codeVerifier: string; redirectUri: string }, http: ProviderFetch, now: number) {
      const t = await token(http, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier });
      const grant: Grant = { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: expiry(t.expiresIn, now) };
      return { grant, scopes: t.scope === null ? [...client.scopes] : t.scope.split(' ').filter(Boolean) };
    },

    /** A fresh access token. The provider may send a new refresh token; else the old one stays (RFC 6749 6). */
    async refresh(grant: Grant, http: ProviderFetch, now: number): Promise<Grant> {
      if (!grant.refreshToken) throw new ProviderError('invalid_grant', 'the grant has no refresh token');
      const t = await token(http, { grant_type: 'refresh_token', refresh_token: grant.refreshToken });
      return { accessToken: t.accessToken, refreshToken: t.refreshToken ?? grant.refreshToken, expiresAt: expiry(t.expiresIn, now) };
    },

    /** Revoke the refresh token, which takes its access tokens with it, else the access token (RFC 7009 2.1). */
    async revoke(grant: Grant, http: ProviderFetch): Promise<void> {
      if (!client.revokeEndpoint) return;
      const [tokenValue, hint] = grant.refreshToken ? [grant.refreshToken, 'refresh_token'] : [grant.accessToken, 'access_token'];
      const res = await post(http, client.revokeEndpoint, { token: tokenValue, token_type_hint: hint });
      await res.body?.cancel();
      // RFC 7009 2.2: 200 also for a token that was already invalid.
      if (!res.ok) throw new ProviderError('http-status', `the revocation endpoint answered ${res.status}`);
    },
  };
}
