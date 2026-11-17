/**
 * Screen credentials: `sfd_<screenId>.<secret>`, where the secret is 32 random bytes in
 * base64url. Only the lowercase hex SHA-256 of the secret is stored. Opaque to the screen; not a JWT.
 */
import { ID_PATTERN } from '@signforge/contract';

const PREFIX = 'sfd_';
const SECRET = /^[A-Za-z0-9_-]{43}$/;

export interface ParsedCredential {
  screenId: string;
  secret: string;
}

/** Split a credential into screen id and secret, or undefined if it is not one. */
export function parseCredential(token: string): ParsedCredential | undefined {
  if (!token.startsWith(PREFIX)) return undefined;
  const dot = token.indexOf('.', PREFIX.length);
  if (dot < 0) return undefined;
  const screenId = token.slice(PREFIX.length, dot);
  const secret = token.slice(dot + 1);
  if (!ID_PATTERN.test(screenId) || !SECRET.test(secret)) return undefined;
  return { screenId, secret };
}

export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A new credential for a screen, and the hash to store. Hand the credential over once; never log it. */
export async function mintCredential(screenId: string): Promise<{ credential: string; secretHash: string }> {
  if (!ID_PATTERN.test(screenId)) throw new TypeError('screen id must match ID_PATTERN');
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { credential: `${PREFIX}${screenId}.${secret}`, secretHash: await hashSecret(secret) };
}
