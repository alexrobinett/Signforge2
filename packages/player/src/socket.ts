/**
 * The nudge socket (docs/backend-plan.md, Screens): one WebSocket from the screen to its Durable
 * Object, so a publish or a command reaches the screen at once instead of at the next poll.
 *
 * To open it the player asks its sync loop for a ticket (each sync returns one, good for 60
 * seconds), then connects to `<api>/ws?ticket=`: the credential never goes in a URL.
 * While open it sends `ping` every PING_MS, which the server's runtime answers with `pong`
 * without waking the object; a missing pong means the connection is dead and it reconnects. It
 * reconnects with exponential backoff and full jitter, so a fleet that lost the server together
 * does not come back together. Server messages are checked against the contract before use.
 *
 */
import { parseServerSocketMessage, type DeviceCommand, type ServerSocketMessage } from '@signforge/contract';

/** How often to ping. Under the usual 100-second idle timeouts of proxies and NAT. */
export const PING_MS = 50_000;
/** A ping without a pong for this long: the connection is dead. */
export const PONG_TIMEOUT_MS = 10_000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

export interface NudgeSocketOptions {
  /** The API's device base, e.g. `https://api.example/v1/device`. */
  base: string;
  /** A fresh socket ticket, from a sync. Rejects with `UnauthorisedSync` if the server refused the credential. */
  ticket: () => Promise<string>;
  /** A new manifest is published: sync now. */
  onNudge: () => void;
  onCommand: (command: DeviceCommand) => void;
  /** The server refused the credential (a 401 on sync, or `revoked` on the socket). */
  onUnauthorised: () => void;
  /** The socket opened or closed. */
  onChange?: (open: boolean) => void;
  pingMs?: number;
}

export class UnauthorisedSync extends Error {}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class NudgeSocket {
  private ws: WebSocket | undefined;
  private applied = '';
  private stopped = false;
  /** Told it was revoked: wait long before trying again, the credential is dead. */
  private revoked = false;

  constructor(private readonly opts: NudgeSocketOptions) {}

  /** Whether the socket is open: while it is, the player does not poll. */
  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Keep a socket open until `stop`. */
  start(): void {
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close(1000);
  }

  /** Tell the server which manifest is on screen now, and again whenever the socket reopens. */
  reportApplied(manifestId: string): void {
    this.applied = manifestId;
    this.send({ type: 'applied', manifest: manifestId });
  }

  private send(msg: unknown): void {
    if (this.open) this.ws!.send(JSON.stringify(msg));
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      let opened = false;
      try {
        const ticket = await this.opts.ticket();
        opened = await this.connect(ticket);
      } catch (err) {
        if (err instanceof UnauthorisedSync) this.opts.onUnauthorised();
        else console.warn('[sf] socket:', err instanceof Error ? err.message : String(err));
      }
      failures = opened && !this.revoked ? 0 : Math.max(failures + 1, this.revoked ? 5 : 0);
      this.revoked = false;
      // Full jitter: anywhere from nothing to the backoff ceiling.
      const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(failures, 10));
      await sleep(BACKOFF_MIN_MS / 2 + Math.random() * ceiling);
    }
  }

  /** Open a socket and resolve when it closes: true if it was open at all. */
  private connect(ticket: string): Promise<boolean> {
    const url = new URL(`${this.opts.base}/ws`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('ticket', ticket);
    const ws = new WebSocket(url);
    this.ws = ws;
    return new Promise((resolve) => {
      let opened = false;
      let pinger: ReturnType<typeof setInterval> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      ws.onopen = () => {
        opened = true;
        this.opts.onChange?.(true);
        if (this.applied) this.send({ type: 'applied', manifest: this.applied });
        // No sync here for nudges missed while it was down: the sync that issued the ticket was just now.
        pinger = setInterval(() => {
          ws.send('ping');
          deadline ??= setTimeout(() => ws.close(4000, 'no pong'), PONG_TIMEOUT_MS);
        }, this.opts.pingMs ?? PING_MS);
      };
      ws.onmessage = (e) => {
        if (e.data === 'pong') {
          clearTimeout(deadline);
          deadline = undefined;
          return;
        }
        let msg: unknown;
        try {
          msg = JSON.parse(String(e.data));
        } catch {
          return;
        }
        const parsed = parseServerSocketMessage(msg);
        if (!parsed.ok) return console.warn('[sf] socket: ignored a message:', parsed.problems.join('; '));
        this.handle(parsed.value, ws);
      };
      ws.onclose = () => {
        clearInterval(pinger);
        clearTimeout(deadline);
        if (this.ws === ws) this.ws = undefined;
        if (opened) this.opts.onChange?.(false);
        resolve(opened);
      };
    });
  }

  private handle(msg: ServerSocketMessage, ws: WebSocket): void {
    switch (msg.type) {
      case 'manifest':
        return this.opts.onNudge();
      case 'command':
        return this.opts.onCommand(msg.command);
      case 'revoked':
        this.revoked = true;
        ws.close(1000);
        return this.opts.onUnauthorised();
    }
  }
}
