/**
 * The screen's Durable Object (docs/backend-plan.md, Screens), one per screen, named by screen id.
 * It holds the screen's nudge socket and the desired and reported manifest ids.
 *
 * The socket hibernates: between messages the object is evicted and costs nothing. The screen's
 * keepalive (`ping`) is answered by the runtime (`setWebSocketAutoResponse`) without waking it.
 * The object runs only when something happens: a publish or command to send, a revoked credential,
 * or the screen's `applied`, which it writes through to D1 so the CMS reads rollout from D1 and
 * never calls 1,000 objects.
 *
 * Only the Worker reaches it: `/v1/device/ws` after checking the socket ticket, and the tool
 * dispatcher's `ScreenNotifier` (./screens.ts) after a change is committed.
 */
import { parseDeviceSocketMessage, type DeviceCommand, type ServerSocketMessage } from '@signforge/contract';
import { scoped } from '@signforge/db';
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
    const pair = new WebSocketPair();
    // Tagged with its credential, so revoking one credential closes only its sockets.
    this.ctx.acceptWebSocket(pair[1], [holder.credentialId]);
    pair[1].serializeAttachment(holder);
    await this.ctx.storage.put('orgId', holder.orgId);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** A new desired manifest: tell the screen to sync now. */
  async manifest(id: string): Promise<void> {
    await this.ctx.storage.put('desired', id);
    this.send({ type: 'manifest', id });
  }

  /** A command to act on at once (a display override, reload, reboot). */
  async command(command: DeviceCommand): Promise<void> {
    this.send({ type: 'command', command });
  }

  /** The credential was revoked: say so and close every socket it opened. */
  async revoked(credentialId: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets(credentialId)) {
      try {
        ws.send(JSON.stringify({ type: 'revoked' } satisfies ServerSocketMessage));
        ws.close(CLOSE_REVOKED, 'revoked');
      } catch {
        // Already closing.
      }
    }
  }

  /** Desired and reported manifest ids, for tests and debugging. */
  async manifests(): Promise<{ desired?: string; reported?: string }> {
    const [desired, reported] = await Promise.all([this.ctx.storage.get<string>('desired'), this.ctx.storage.get<string>('reported')]);
    return { desired, reported };
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
    const { manifest } = parsed.value;
    if ((await this.ctx.storage.get<string>('reported')) === manifest) return;
    const holder = ws.deserializeAttachment() as SocketHolder;
    // The screen reporting about itself, through its org's scope: the only write the socket makes.
    await scoped(this.env.DB, holder.orgId).screens.update(holder.screenId, { reportedManifestId: manifest });
    await this.ctx.storage.put('reported', manifest);
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  private send(msg: ServerSocketMessage): void {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        // A socket closing as we send: the screen syncs when it reconnects.
      }
    }
  }
}
