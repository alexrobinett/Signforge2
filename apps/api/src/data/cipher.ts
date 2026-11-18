/**
 * Feed URLs at rest (docs/backend-plan.md, Data model: a private calendar URL is a secret).
 * AES-256-GCM under a key derived from the DATA_SOURCE_KEY secret, with the source's org and id as
 * additional data, so a sealed URL copied into another row, or another org, does not open.
 * Stored as `v1.<iv>.<ciphertext>`, both base64url.
 */
import type { FeedUrlSealer } from '@signforge/tools';

/** Only for `wrangler dev` and tests. Every other environment must set the DATA_SOURCE_KEY secret. */
const DEV_KEY = 'signforge-dev-data-source-key-not-for-deployed-environments';

type KeyEnv = Pick<Env, 'DATA_SOURCE_KEY' | 'ENVIRONMENT'>;
type Source = { orgId: string; id: string };

const encoder = new TextEncoder();
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function key(env: KeyEnv): Promise<CryptoKey> {
  const secret = env.DATA_SOURCE_KEY ?? (env.ENVIRONMENT === 'dev' ? DEV_KEY : undefined);
  if (!secret) throw new Error('DATA_SOURCE_KEY is not set');
  const base = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: encoder.encode('sf-feed-url.v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

const aad = (source: Source) => encoder.encode(`${source.orgId}/${source.id}`);

export function feedUrlSealer(env: KeyEnv): FeedUrlSealer {
  return {
    seal: async (source, url) => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(source) }, await key(env), encoder.encode(url));
      return `v1.${b64url(iv)}.${b64url(new Uint8Array(sealed))}`;
    },
  };
}

/** The URL sealed for `source`, or undefined if it was sealed for another source, under another key, or is not a sealed URL. */
export async function openFeedUrl(env: KeyEnv, source: Source, sealed: string): Promise<string | undefined> {
  const [v, iv, data] = sealed.split('.');
  if (v !== 'v1' || !iv || !data) return undefined;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(iv), additionalData: aad(source) }, await key(env), fromB64url(data));
    return new TextDecoder().decode(plain);
  } catch {
    return undefined;
  }
}
