import { isId } from '@signforge/contract';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * A new id such as `scr_k3x9...`: a short prefix naming the table, then 24 random base32
 * characters (120 bits). Always matches the contract's `ID_PATTERN`.
 */
export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let out = `${prefix}_`;
  for (const b of bytes) out += ALPHABET[b & 31];
  return out;
}

export function assertId(id: unknown, what = 'id'): asserts id is string {
  if (!isId(id)) throw new TypeError(`${what} must match ID_PATTERN: ${JSON.stringify(id)}`);
}
