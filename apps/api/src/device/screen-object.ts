/**
 * The screen's Durable Object (docs/backend-plan.md, Screens), one per screen, named by screen id.
 * It holds the screen's nudge socket. The desired manifest id is in D1 (`screens.desired_manifest_id`),
 * where sync and the manifest route read it.
 *
 * The socket hibernates: between messages the object is evicted and costs nothing. The screen's
 * keepalive (`ping`) is answered by the runtime (`setWebSocketAutoResponse`) without waking it.
 * The object runs only when something happens: a publish or command to send, a revoked credential,
 * or the screen's `applied`, which it writes through to D1 so the CMS reads rollout from D1 and
 * never calls 1,000 objects.
 *
 * Only the Worker reaches it: `/v1/device/ws` after checking the socket ticket, and the tool
 * dispatcher's `ScreenNotifier` (./screens.ts) after a change is committed.
 *
 * Revocation is recorded in D1 before the object hears of it, and the notice can fail. So the
 * object does not trust a socket's credential to stay live: before it sends a socket anything, or
 * writes what one applied, it reads the screen's live credentials from D1 and closes a socket
 * whose credential is gone. A notice that does arrive is remembered, so an upgrade the Worker
 * checked just before the revocation is refused when it reaches the object after it.
 */
import { parseDeviceSocketMessage, type DeviceCommand, type ServerSocketMessage } from '@signforge/contract';
import { findDeviceScreen, scoped } from '@signforge/db';
import { DurableObject } from 'cloudflare:workers';

/** Who a socket belongs to, checked by the Worker before it was accepted. */
export interface SocketHolder {
  orgId: string;
  screenId: string;
  credentialId: string;
}

/** The header the Worker passes the checked holder in. Not readable from outside: only the Worker calls the object. */
export const HOLDER_HEADER = 'x-sf-socket-holder';

/** The screen's keepalive and its automatic answer. */
const PING = 'ping';
const PONG = 'pong';

/** Close code for a revoked credential (4000-4999 is the application's range). */
const CLOSE_REVOKED = 4001;

export class ScreenObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  override async fetch(request: Request): Promise<Response> {
    const holder = JSON.parse(request.headers.get(HOLDER_HEADER) ?? 'null') as SocketHolder | null;
    if (!holder || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 400 });
    if (await this.ctx.storage.get(revokedKey(holder.credentialId))) return new Response(null, { status: 401 });
    const pair = new WebSocketPair();
    // Tagged with its credential, so revoking one credential closes only its sockets.
    this.ctx.acceptWebSocket(pair[1], [holder.credentialId]);
    pair[1].serializeAttachment(holder);
    await this.ctx.storage.put('orgId', holder.orgId);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** A new desired manifest: tell the screen to sync now. */
  async manifest(id: string): Promise<void> {
    await this.send({ type: 'manifest', id });
  }

  /** A command to act on at once (a display override, reload, reboot). */
  async command(command: DeviceCommand): Promise<void> {
    await this.send({ type: 'command', command });
  }

  /** The credential was revoked: say so and close every socket it opened, and refuse any it opens later. Safe to repeat. */
  async revoked(credentialId: string): Promise<void> {
    await this.ctx.storage.put(revokedKey(credentialId), true);
    for (const ws of this.ctx.getWebSockets(credentialId)) closeRevoked(ws);
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    let msg: unknown;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    const parsed = parseDeviceSocketMessage(msg);
    if (!parsed.ok) return;
    const holder = ws.deserializeAttachment() as SocketHolder;
    if (!(await liveCredentials(this.env.DB, holder.screenId)).has(holder.credentialId)) return closeRevoked(ws);
    // The screen reporting about itself, through its org's scope: the only write the socket makes.
    // Not skipped when this object saw the same id last: a sync may have reported another since.
    await scoped(this.env.DB, holder.orgId).screens.reportManifest(holder.screenId, parsed.value.manifest);
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  /** Send to every socket whose credential is still live; close the others. */
  private async send(msg: ServerSocketMessage): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return;
    const live = await liveCredentials(this.env.DB, (sockets[0]!.deserializeAttachment() as SocketHolder).screenId);
    const text = JSON.stringify(msg);
    for (const ws of sockets) {
      if (!live.has((ws.deserializeAttachment() as SocketHolder).credentialId)) {
        closeRevoked(ws);
        continue;
      }
      try {
        ws.send(text);
      } catch {
        // A socket closing as we send: the screen syncs when it reconnects.
      }
    }
  }
}

const revokedKey = (credentialId: string) => `revoked:${credentialId}`;

/** The screen's credentials that are not revoked (none once the screen is not active). */
async function liveCredentials(db: D1Database, screenId: string): Promise<Set<string>> {
  return new Set((await findDeviceScreen(db, screenId))?.credentials.map((c) => c.id));
}

function closeRevoked(ws: WebSocket): void {
  try {
    ws.send(JSON.stringify({ type: 'revoked' } satisfies ServerSocketMessage));
    ws.close(CLOSE_REVOKED, 'revoked');
  } catch {
    // Already closing.
  }
}
