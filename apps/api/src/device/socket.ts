/**
 * The nudge socket's two routes: `POST /sync` hands out a ticket, `GET /ws?ticket=` trades it for
 * a WebSocket on the screen's Durable Object. The sync here is M3-06's: it checks the request and
 * answers with the desired manifest, the server time and a ticket, and stores nothing yet. M3-07
 * adds play counts, snapshots, the clock and the heartbeat.
 */
import { validateSyncRequest, type SyncRequest, type SyncResponse } from '@signforge/contract';
import { findDeviceScreen } from '@signforge/db';
import type { Context } from 'hono';
import type { DeviceEnv } from './auth';
import { HOLDER_HEADER, type SocketHolder } from './screen-object';
import { screenObject } from './screens';
import { issueTicket, verifyTicket } from './ticket';

/** How often a screen syncs while its socket is up. */
export const SYNC_INTERVAL_S = 300;

const refuse = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } });

export async function syncRoute(c: Context<DeviceEnv>): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return refuse(400, 'the body is not JSON');
  }
  const problems = validateSyncRequest(body);
  if (problems.length) return c.json({ error: 'invalid sync request', problems }, 400);
  const req = body as SyncRequest;
  const screen = c.get('screen');
  const res: SyncResponse = {
    serverTime: new Date().toISOString(),
    nextSyncS: SYNC_INTERVAL_S,
    epoch: req.epoch,
    ackSeq: 0,
    ...(screen.desiredManifestId ? { desiredManifest: screen.desiredManifestId } : {}),
    snapshots: [],
    socketTicket: await issueTicket(c.env, { screenId: screen.screenId, credentialId: c.get('credentialId') }),
    commands: [],
  };
  return c.json(res, 200, { 'cache-control': 'no-store' });
}

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
  headers.set(HOLDER_HEADER, JSON.stringify(checked));
  return screenObject(c.env, holder.screenId).fetch(new Request(c.req.raw.url, { headers }));
}
