/**
 * Connectors (docs/backend-plan.md, Connectors): the provider adapters this deployment has, and
 * `Connectors`, which the connection tools (`@signforge/tools`) call to start and finish an
 * OAuth authorization and to revoke a grant. Tokens stay here: the tools get sealed values only.
 */
import { type Connectors, ToolError } from '@signforge/tools';
import { b64url } from '../data/cipher';
import { type ProviderAdapter, ProviderError, providerFetch } from './adapter';
import { openGrant, openVerifier, sealGrant, sealVerifier } from './vault';

/**
 * Each provider's adapter, built from the environment, or undefined where its OAuth client is
 * not configured. Each connector ticket (Google Calendar, Sheets, Square, Slack) adds its own;
 * tests use a fake provider (test/fake-provider.ts).
 */
const ADAPTERS: readonly ((env: Env) => ProviderAdapter | undefined)[] = [];

/** What the connector code reaches providers with. The Worker's by default; tests pass a fake provider's. */
export interface ConnectorDeps {
  adapters: readonly ProviderAdapter[];
  fetch: typeof fetch;
}

/** workerd's `fetch` throws "Illegal invocation" when called as a method of another object, so it is wrapped. */
const workerFetch: typeof fetch = (input, init) => fetch(input, init);

export const connectorDeps = (env: Env): ConnectorDeps => ({ adapters: ADAPTERS.flatMap((make) => make(env) ?? []), fetch: workerFetch });

/** A PKCE code verifier, 32 random bytes as 43 characters, and its S256 challenge (RFC 7636 4.1, 4.2). */
async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

/** The connection tools' `Connectors`, with the provider sending the browser back to `redirectUri` (the callback route). */
export function connectorsFor(env: Env, deps: ConnectorDeps, redirectUri: string): Connectors {
  const adapterOf = (provider: string) => {
    const adapter = deps.adapters.find((a) => a.provider === provider);
    if (!adapter) throw new ToolError('invalid_input', `${provider} cannot be connected here`);
    return adapter;
  };
  return {
    providers: deps.adapters.map((a) => a.provider),

    begin: async (provider, authorization, state) => {
      const adapter = adapterOf(provider);
      const { verifier, challenge } = await pkce();
      return {
        authorizeUrl: adapter.authorizeUrl({ state, codeChallenge: challenge, redirectUri }),
        verifierSealed: await sealVerifier(env, authorization, verifier),
      };
    },

    finish: async (provider, authorization, code, connection) => {
      const adapter = adapterOf(provider);
      const codeVerifier = await openVerifier(env, authorization, authorization.verifierSealed);
      if (codeVerifier === undefined) throw new ToolError('invalid_input', 'this authorization can no longer be finished (its key changed); start again');
      try {
        const { grant, account, scopes } = await adapter.exchange({ code, codeVerifier, redirectUri }, providerFetch(adapter, deps.fetch), Date.now());
        return { credentialsSealed: await sealGrant(env, connection, grant), account, scopes, expiresAt: grant.expiresAt };
      } catch (e) {
        if (!(e instanceof ProviderError)) throw e;
        // biome-ignore lint/style/useErrorCause: the cause is passed, in the options argument.
        throw new ToolError('invalid_input', `${provider} did not grant the connection (${e.code}); start again`, { reason: e.code }, false, { cause: e });
      }
    },

    revoke: async (provider, connection, credentialsSealed) => {
      const adapter = deps.adapters.find((a) => a.provider === provider);
      const grant = await openGrant(env, connection, credentialsSealed);
      if (!adapter?.revoke || !grant) return;
      try {
        await adapter.revoke(grant, providerFetch(adapter, deps.fetch));
      } catch (e) {
        if (!(e instanceof ProviderError)) throw e;
        console.warn(`[connectors] ${provider} did not revoke connection ${connection.id} (${e.code}); its credentials are deleted anyway`);
      }
    },
  };
}
