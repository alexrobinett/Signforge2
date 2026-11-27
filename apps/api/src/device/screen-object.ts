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
import { parseDeviceSocketMessage, type DeviceCommand, type DeviceSocketMessage, type ServerSocketMessage } from '@signforge/contract';
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

/**
 * How long one `applied` report, or the credentials read before a send, may wait on D1. A report
 * is one indexed read and one single-row write, milliseconds when D1 is well, but D1 gives up on a
 * query only after 30 seconds and the object cannot cancel one, so a hung call would hold the next
 * report behind it. A report given up on here is not missed for long: the screen's next sync (at
 * most 5 minutes) writes the same column. So a credentials read that takes 10 to 30 s and then
 * succeeds drops its report even when no later one came; the CMS reads "updating" until that sync.
 * That is intended: a write that late could land over a later report. A send given up on is not
 * sent (its credentials were never checked). A manifest and a display override are stored, so the screen's next sync
 * brings them; an identify or a restart is not, and is lost: both are for someone at the screen now (#519).
 */
export const D1_LIMIT_MS = 10_000;

export class ScreenObject extends DurableObject<Env> {
  /**
   * The `applied` reports taken so far, written one at a time. The runtime delivers a message while
   * an earlier one awaits D1, so without this two reports without a time could land in either order (gh-177).
   */
  private handling: Promise<void> = Promise.resolve();
  /**
   * Each socket's report waiting for the one being written, its latest: a report that arrives while its socket's waits
   * replaces it, so a screen sending reports faster than D1 writes them holds one, not a queue. One a socket, so a
   * revoked socket's report, dropped at its write, never replaces a live one's (#519). Each keeps when it arrived.
   */
  private waiting = new Map<WebSocket, { report: DeviceSocketMessage; arrivedAt: number }>();

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

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Parsed as it arrives, so a message that is not an `applied` report is dropped without waiting behind one that is.
    const report = parseReport(message);
    if (!report) return Promise.resolve();
    const replaced = this.waiting.has(ws);
    // Stamped as it arrives, not after its credentials read, as a sync is at its start: a sync that starts after this
    // report arrived is the later one (#519).
    this.waiting.set(ws, { report, arrivedAt: Date.now() });
    // Its place in the queue is taken already: the handling below writes this report instead.
    if (replaced) return Promise.resolve();
    const handled = this.handling.then(() => {
      const next = this.waiting.get(ws)!;
      this.waiting.delete(ws);
      return withinLimit('applied report', (late) => this.writeApplied(ws, next.report, next.arrivedAt, late));
    });
    // A report that failed still lets the next one through; the runtime sees its error.
    this.handling = handled.catch(() => {});
    return handled;
  }

  /** Write what the screen applied, unless its credential is gone or the report ran past its limit while reading it. */
  private async writeApplied(ws: WebSocket, report: DeviceSocketMessage, arrivedAt: number, late: () => boolean): Promise<void> {
    const holder = ws.deserializeAttachment() as SocketHolder;
    if (!(await liveCredentials(this.env.DB, holder.screenId)).has(holder.credentialId)) return closeRevoked(ws);
    // A later report may already have been written: this one must not land over it.
    if (late()) return;
    // The screen reporting about itself, through its org's scope: the only write the socket makes.
    // Not skipped when this object saw the same id last: a sync may have reported another since.
    const { manifest, observedAt } = report;
    await scoped(this.env.DB, holder.orgId).screens.reportManifest(holder.screenId, manifest, {
      ...(observedAt !== undefined && { observedAt: Date.parse(observedAt) }),
      arrivedAt,
    });
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
    const screenId = (sockets[0]!.deserializeAttachment() as SocketHolder).screenId;
    const live = await withinLimit('send', () => liveCredentials(this.env.DB, screenId));
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

/**
 * `work` on D1, rejected after `D1_LIMIT_MS`. A D1 call cannot be cancelled, so `late` tells work
 * that goes on to write whether its limit has passed. A late rejection of the call is still handled.
 */
function withinLimit<T>(what: string, work: (late: () => boolean) => Promise<T>): Promise<T> {
  let late = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      late = true;
      reject(new Error(`${what} waited on D1 for ${D1_LIMIT_MS} ms`));
    }, D1_LIMIT_MS);
  });
  return Promise.race([work(() => late), limit]).finally(() => clearTimeout(timer));
}

/** The screen's `applied` report, or undefined for anything else it sends (binary, not JSON, not a valid message). */
function parseReport(message: string | ArrayBuffer): DeviceSocketMessage | undefined {
  if (typeof message !== 'string') return undefined;
  let msg: unknown;
  try {
    msg = JSON.parse(message);
  } catch {
    return undefined;
  }
  const parsed = parseDeviceSocketMessage(msg);
  return parsed.ok ? parsed.value : undefined;
}

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
