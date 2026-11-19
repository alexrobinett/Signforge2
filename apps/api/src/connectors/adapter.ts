/**
 * A provider adapter (docs/backend-plan.md, Connectors): what the API needs from one provider to
 * connect an account and read a provider data source. Each connector ticket adds one, usually
 * built on the OAuth 2.0 client in ./oauth.ts. An adapter reaches only its provider's fixed API
 * hosts (`hosts`), through `providerFetch`: provider requests do not go through the guards for
 * URLs people type (../data/fetch.ts), and nothing else may be reached with a provider's token.
 */

/** What a connection holds, sealed (./vault.ts). An API key is a grant with no refresh token and no expiry. */
export interface Grant {
  accessToken: string;
  refreshToken: string | null;
  /** When the access token runs out; null if it does not. */
  expiresAt: number | null;
}

/**
 * Why a provider request failed, as a source's or a connection's `last_error` records it.
 * `invalid_grant`: the provider refused the grant or the code (RFC 6749 5.2), so the account
 * must be connected again; `unauthorized`: it refused the access token (401).
 */
export type ProviderErrorCode = 'invalid_grant' | 'unauthorized' | 'host-not-allowed' | 'redirect' | 'timeout' | 'network' | 'http-status' | 'malformed';

/** A provider's refusal or failure. Its message is fixed text: never a token, never the provider's body. */
export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProviderError';
  }
}

/** `fetch` as an adapter gets it: to its own hosts only (`providerFetch`). */
export type ProviderFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ProviderAdapter {
  /** The provider's name, as connections store it and `start_connection` takes it. */
  provider: string;
  /** The only hosts its requests may reach, over https on the default port. */
  hosts: readonly string[];
  /** The provider's authorize URL for one authorization: `state`, and the PKCE challenge (S256). */
  authorizeUrl(a: { state: string; codeChallenge: string; redirectUri: string }): string;
  /** The grant for an authorization code, and the account it is for and the scopes it grants. */
  exchange(
    a: { code: string; codeVerifier: string; redirectUri: string },
    http: ProviderFetch,
    now: number,
  ): Promise<{ grant: Grant; account: string; scopes: string[] }>;
  /** A fresh access token. A grant the provider refuses is `invalid_grant`. */
  refresh(grant: Grant, http: ProviderFetch, now: number): Promise<Grant>;
  /** Revoke the grant at the provider. Absent for a provider that cannot. */
  revoke?(grant: Grant, http: ProviderFetch): Promise<void>;
  /** The resource's data, as a snapshot holds it. An access token the provider refuses is `unauthorized`. */
  fetch(resource: string, grant: Grant, http: ProviderFetch): Promise<unknown>;
}

/** Each provider request has as long as a feed fetch, the whole of it. */
const PROVIDER_TIMEOUT_MS = 5000;

/**
 * `base` for `adapter`: https on the default port to one of its hosts, or a `host-not-allowed`
 * refusal before anything is sent. A redirect is not followed (it could leave the hosts, with
 * the token): it is a `redirect` failure.
 */
export function providerFetch(adapter: Pick<ProviderAdapter, 'hosts'>, base: typeof fetch): ProviderFetch {
  return async (url, init) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.port !== '' || u.username || u.password || !adapter.hosts.includes(u.hostname))
      throw new ProviderError('host-not-allowed', `${u.protocol}//${u.host} is not one of this provider's hosts`);
    const signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
    let res: Response;
    try {
      res = await base(u.href, { ...init, redirect: 'manual', signal });
    } catch (e) {
      // biome-ignore lint/style/useErrorCause: the cause is passed, in the options argument.
      throw new ProviderError(
        signal.aborted ? 'timeout' : 'network',
        signal.aborted ? 'the provider did not answer in time' : 'the provider could not be reached',
        { cause: e },
      );
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      throw new ProviderError('redirect', `the provider redirected (${res.status})`);
    }
    return res;
  };
}
