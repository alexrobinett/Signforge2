/**
 * Connections' secrets at rest, under the CONNECTION_KEY secret (separate from feed URLs'
 * DATA_SOURCE_KEY), with ../data/cipher.ts: a connection's grant bound to its org and id, and
 * a pending authorization's PKCE verifier bound to its org and state. Opened only here, by the
 * connector code: no tool, response or log line gets a token.
 */
import { open, seal, sealingKey } from '../data/cipher';
import type { Grant } from './adapter';

/** Only for `wrangler dev` and tests. Every other environment must set the CONNECTION_KEY secret. */
const DEV_KEY = 'signforge-dev-connection-key-not-for-deployed-environments';

type KeyEnv = Pick<Env, 'CONNECTION_KEY' | 'ENVIRONMENT'>;
type Connection = { orgId: string; id: string };
type Authorization = { orgId: string; stateHash: string };

const key = (env: KeyEnv) =>
  sealingKey({ secret: env.CONNECTION_KEY, devSecret: DEV_KEY, name: 'CONNECTION_KEY', info: 'sf-connection.v1', environment: env.ENVIRONMENT });
// The kind leads, so a sealed verifier copied into a connection's row does not open as its grant.
const grantAad = (c: Connection) => `grant:${c.orgId}/${c.id}`;
const verifierAad = (a: Authorization) => `pkce:${a.orgId}/${a.stateHash}`;

export const sealGrant = async (env: KeyEnv, connection: Connection, grant: Grant) => seal(await key(env), grantAad(connection), JSON.stringify(grant));

/**
 * The grant sealed for `connection`, or undefined if it was sealed for another, under another key,
 * or is not one. What opens was written by `sealGrant`: AES-GCM authenticates it, so it is not parsed again.
 */
export async function openGrant(env: KeyEnv, connection: Connection, sealed: string): Promise<Grant | undefined> {
  const plain = await open(await key(env), grantAad(connection), sealed);
  return plain === undefined ? undefined : JSON.parse(plain);
}

export const sealVerifier = async (env: KeyEnv, authorization: Authorization, verifier: string) => seal(await key(env), verifierAad(authorization), verifier);

export const openVerifier = async (env: KeyEnv, authorization: Authorization, sealed: string) => open(await key(env), verifierAad(authorization), sealed);
