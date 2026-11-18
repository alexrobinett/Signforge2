/**
 * Socket tickets: what a screen trades for its nudge socket at `GET /v1/device/ws?ticket=`.
 *
 * A WebSocket cannot carry a bearer header from a browser, and the credential must never appear in
 * a URL (URLs end up in logs). So sync hands out a ticket instead: `<screenId>.<credentialId>.<expiresMs>.<mac>`,
 * where the mac is an HMAC-SHA256 of the rest under the server's secret. It is good for 60 seconds
 * and names the credential that asked for it, so revoking that credential refuses it too.
 */
import { isId } from '@signforge/contract';
import { authSecret } from '../auth';

const TICKET_TTL_MS = 60_000;

export interface TicketHolder {
  screenId: string;
  credentialId: string;
}

/** Domain separation: the same secret signs Better Auth's cookies. */
const CONTEXT = 'sf-socket-ticket.v1.';
const encoder = new TextEncoder();

const b64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

async function mac(env: Pick<Env, 'AUTH_SECRET' | 'ENVIRONMENT'>, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(authSecret(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, encoder.encode(CONTEXT + payload)));
}

export async function issueTicket(env: Pick<Env, 'AUTH_SECRET' | 'ENVIRONMENT'>, holder: TicketHolder, now = Date.now()): Promise<string> {
  const payload = `${holder.screenId}.${holder.credentialId}.${now + TICKET_TTL_MS}`;
  return `${payload}.${await mac(env, payload)}`;
}

/** Who the ticket was issued to, or undefined if it is forged, malformed or expired. */
export async function verifyTicket(env: Pick<Env, 'AUTH_SECRET' | 'ENVIRONMENT'>, ticket: string, now = Date.now()): Promise<TicketHolder | undefined> {
  const parts = ticket.split('.');
  if (parts.length !== 4) return undefined;
  const [screenId, credentialId, expires, given] = parts as [string, string, string, string];
  if (!isId(screenId) || !isId(credentialId) || !/^\d{1,16}$/.test(expires)) return undefined;
  const expected = await mac(env, `${screenId}.${credentialId}.${expires}`);
  const x = encoder.encode(expected);
  const y = encoder.encode(given);
  if (x.byteLength !== y.byteLength || !crypto.subtle.timingSafeEqual(x, y)) return undefined;
  if (now > Number(expires)) return undefined;
  return { screenId, credentialId };
}
