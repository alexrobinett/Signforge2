// The API's connectors stubbed for the generated tests (isolation, write guard): no provider is
// reached, and finish_connection's example state can be made pending for a caller.
import { testScope } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { type Connectors, registry } from '../src';

/** The API's OAuth, stubbed: no provider is reached. */
export const connectors: Connectors = {
  providers: ['google'],
  begin: async (_provider, _authorization, state) => ({ authorizeUrl: `https://accounts.test/authorize?state=${state}`, verifierSealed: 'sealed-verifier' }),
  finish: async () => ({ credentialsSealed: 'sealed-grant', account: 'someone@example.test', scopes: ['read'], expiresAt: null }),
  revoke: async () => undefined,
};

/** A pending authorization of `orgId`'s, started by `actorId`, for finish_connection's example state. */
export async function pendingFor(orgId: string, actorId: string) {
  const example = registry.get('finish_connection')!.example as { oauthState: string };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(example.oauthState));
  const stateHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  await testScope(env.DB, orgId).connections.authorizations.insert({
    provider: 'google',
    stateHash,
    verifierSealed: 'sealed-verifier',
    actorKind: 'user',
    actorId,
    expiresAt: Date.now() + 600_000,
  });
}
