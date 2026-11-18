/**
 * The nudge socket's route: `GET /ws?ticket=` trades a ticket from the sync (./sync.ts) for a
 * WebSocket on the screen's Durable Object.
 */
import { findDeviceScreen } from '@signforge/db';
import type { Context } from 'hono';
import type { DeviceEnv } from './auth';
import { HOLDER_HEADER, type SocketHolder } from './screen-object';
import { screenObject } from './screens';
import { verifyTicket } from './ticket';

const refuse = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } });

/** Not behind the bearer middleware: a browser cannot set headers on a WebSocket, so the ticket is the credential here. */
export async function socketRoute(c: Context<DeviceEnv>): Promise<Response> {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') return refuse(426, 'expected a WebSocket upgrade');
  const holder = await verifyTicket(c.env, c.req.query('ticket') ?? '');
  if (!holder) return refuse(401, 'unauthorized');
  // The ticket lives 60 seconds; the credential may have been revoked within them.
  const screen = await findDeviceScreen(c.env.DB, holder.screenId);
  if (!screen?.credentials.some((cr) => cr.id === holder.credentialId)) return refuse(401, 'unauthorized');
  const checked: SocketHolder = { orgId: screen.orgId, ...holder };
  const headers = new Headers(c.req.raw.headers);
  headers.delete('cookie');
  headers.set(HOLDER_HEADER, JSON.stringify(checked));
  return screenObject(c.env, holder.screenId).fetch(new Request(c.req.raw.url, { headers }));
}
