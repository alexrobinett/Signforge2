/**
 * Secrets at rest (docs/backend-plan.md, Data model: a private calendar URL is a secret).
 * AES-256-GCM under a key derived from a Worker secret, with what the secret belongs to (an
 * org and a row id) as additional data, so a sealed value copied into another row, or another
 * org, does not open. Stored as `v1.<iv>.<ciphertext>`, both base64url.
 *
 * Feed URLs, provider resources, and alert channels' URLs and signing secrets (#88) are sealed
 * under DATA_SOURCE_KEY, the channels under a key of their own (their org, kind and field as
 * additional data); connections' credentials under CONNECTION_KEY (../connectors/vault.ts).
 */
import type { AlertSecretSealer, FeedUrlSealer } from '@signforge/tools';

/** Only for `wrangler dev` and tests. Every other environment must set the DATA_SOURCE_KEY secret. */
const DEV_KEY = 'signforge-dev-data-source-key-not-for-deployed-environments';

type KeyEnv = Pick<Env, 'DATA_SOURCE_KEY' | 'ENVIRONMENT'>;
type Source = { orgId: string; id: string };
type Channel = { orgId: string; kind: 'slack' | 'webhook' };

const encoder = new TextEncoder();
export const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** A Worker secret unset outside dev: a deploy left it out, and setting it mends it. */
export class MissingKey extends Error {
  constructor(name: string) {
    super(`${name} is not set`);
    this.name = 'MissingKey';
  }
}

/**
 * The AES-GCM key for one purpose (`info`), from `secret`; in dev, from `devSecret` when the
 * secret is unset. `name` is the secret's, for the error (`MissingKey`).
 */
export async function sealingKey(k: { secret: string | undefined; devSecret: string; name: string; info: string; environment: string }): Promise<CryptoKey> {
  const secret = k.secret ?? (k.environment === 'dev' ? k.devSecret : undefined);
  if (!secret) throw new MissingKey(k.name);
  const base = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: encoder.encode(k.info) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** `plain` sealed under `key`, bound to `aad`. */
export async function seal(key: CryptoKey, aad: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) }, key, encoder.encode(plain));
  return `v1.${b64url(iv)}.${b64url(new Uint8Array(sealed))}`;
}

/** What was sealed under `key` for `aad`, or undefined if it was sealed for something else, under another key, or is not sealed. */
export async function open(key: CryptoKey, aad: string, sealed: string): Promise<string | undefined> {
  const [v, iv, data] = sealed.split('.');
  if (v !== 'v1' || !iv || !data) return undefined;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(iv), additionalData: encoder.encode(aad) }, key, fromB64url(data));
    return new TextDecoder().decode(plain);
  } catch {
    return undefined;
  }
}

const key = (env: KeyEnv) =>
  sealingKey({ secret: env.DATA_SOURCE_KEY, devSecret: DEV_KEY, name: 'DATA_SOURCE_KEY', info: 'sf-feed-url.v1', environment: env.ENVIRONMENT });
const aad = (source: Source) => `${source.orgId}/${source.id}`;

export function feedUrlSealer(env: KeyEnv): FeedUrlSealer {
  return { seal: async (source, url) => seal(await key(env), aad(source), url) };
}

/** The URL sealed for `source`, or undefined if it was sealed for another source, under another key, or is not a sealed URL. */
export async function openFeedUrl(env: KeyEnv, source: Source, sealed: string): Promise<string | undefined> {
  return open(await key(env), aad(source), sealed);
}

const channelKey = (env: KeyEnv) =>
  sealingKey({ secret: env.DATA_SOURCE_KEY, devSecret: DEV_KEY, name: 'DATA_SOURCE_KEY', info: 'sf-alert-channel.v1', environment: env.ENVIRONMENT });
const channelAad = (channel: Channel, field: 'url' | 'secret') => `${channel.orgId}/${channel.kind}/${field}`;

export function alertSecretSealer(env: KeyEnv): AlertSecretSealer {
  return { seal: async (channel, field, value) => seal(await channelKey(env), channelAad(channel, field), value) };
}

/**
 * The channel's URL or secret, or undefined if it was sealed for another channel, field or org, or
 * under another key. Throws `MissingKey` without the key, so a delivery is retried, not given up on.
 */
export async function openAlertSecret(env: KeyEnv, channel: Channel, field: 'url' | 'secret', sealed: string): Promise<string | undefined> {
  return open(await channelKey(env), channelAad(channel, field), sealed);
}
