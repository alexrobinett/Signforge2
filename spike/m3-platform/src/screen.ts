/**
 * The screen's Durable Object, reduced to what the spike measures: one hibernating WebSocket
 * whose "ping" is answered by the runtime, and counters that show when JavaScript ran.
 * `constructs` rises each time the object is (re)created, so a ping that woke it would show.
 */
import { DurableObject } from 'cloudflare:workers';

export class SpikeScreen extends DurableObject<Env> {
  private readonly instance = crypto.randomUUID().slice(0, 8);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, n INTEGER NOT NULL)');
    this.bump('constructs');
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  private bump(name: string) {
    this.ctx.storage.sql.exec('INSERT INTO counters VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET n = n + 1', name);
  }

  private counters() {
    return Object.fromEntries(this.ctx.storage.sql.exec<{ name: string; n: number }>('SELECT name, n FROM counters').toArray().map((r) => [r.name, r.n]));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade') !== 'websocket') return Response.json(this.counters());
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    this.bump('accepts');
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    this.bump('messages');
    if (message === 'stats') {
      const last = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      ws.send(JSON.stringify({ deployMark: (this.env as { DEPLOY_MARK?: string }).DEPLOY_MARK ?? 'none', instance: this.instance, counters: this.counters(), lastAutoResponse: last?.toISOString() ?? null }));
    }
  }

  override async webSocketClose(ws: WebSocket, code: number) {
    ws.close(code, 'bye');
  }

  /** The publish fan-out's per-screen call. */
  async nudge(manifestId: string): Promise<string> {
    this.bump('nudges');
    for (const ws of this.ctx.getWebSockets()) ws.send(JSON.stringify({ type: 'manifest', id: manifestId }));
    return this.instance;
  }

  async resetCounters() {
    this.ctx.storage.sql.exec('DELETE FROM counters');
  }
}
