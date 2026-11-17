/**
 * The nudge socket (docs/backend-plan.md, Screens): one WebSocket from the screen to its Durable
 * Object, so a publish or a command reaches the screen at once instead of at the next poll.
 *
 * To open it the player syncs (`POST <api>/sync`, with the credential as a bearer header) for a
 * 60-second ticket, then connects to `<api>/ws?ticket=`: the credential never goes in a URL.
 * While open it sends `ping` every PING_MS, which the server's runtime answers with `pong`
 * without waking the object; a missing pong means the connection is dead and it reconnects. It
 * reconnects with exponential backoff and full jitter, so a fleet that lost the server together
 * does not come back together. Server messages are checked against the contract before use.
 *
 * The sync here carries no play counts and keeps no `seq`: M3-07 makes it the full heartbeat.
 */
import {
  SUPPORTED_MANIFEST_SCHEMAS,
  SUPPORTED_PROTOCOLS,
  validateServerSocketMessage,
  validateSyncResponse,
  type DeviceCommand,
  type ServerSocketMessage,
  type SyncRequest,
  type SyncResponse,
} from '@signforge/contract';

/** How often to ping. Under the usual 100-second idle timeouts of proxies and NAT. */
export const PING_MS = 50_000;
/** A ping without a pong for this long: the connection is dead. */
export const PONG_TIMEOUT_MS = 10_000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

export interface NudgeSocketOptions {
  /** The API's device base, e.g. `https://api.example/v1/device`. */
  base: string;
  /** The credential header, collected from the supervisor. */
  headers: () => Promise<Record<string, string>>;
  /** What the screen reports in its sync. */
  status: () => { active?: string; displayOn: boolean };
  /** A new manifest is published, or the socket (re)connected and may have missed one: sync now. */
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
const randomId = () => `e${crypto.getRandomValues(new Uint32Array(2)).join('')}`;

export class NudgeSocket {
  private ws: WebSocket | undefined;
  private applied = '';
  /** Names this run's (empty) seq numbers until M3-07 keeps a counter; never from the clock. */
  private readonly epoch = randomId();
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
        const ticket = await this.ticket();
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

  private async ticket(): Promise<string> {
    const s = this.opts.status();
    const body: SyncRequest = {
      seq: 0,
      epoch: this.epoch,
      player: { version: 'dev', manifestSchemas: SUPPORTED_MANIFEST_SCHEMAS, protocols: SUPPORTED_PROTOCOLS },
      manifest: { ...(s.active ? { active: s.active } : {}), filesMissing: 0 },
      display: { on: s.displayOn },
      deviceTime: new Date().toISOString(),
      clock: { offsetMs: 0, trusted: false },
      playCounts: [],
      snapshots: {},
    };
    const res = await fetch(`${this.opts.base}/sync`, {
      method: 'POST',
      cache: 'no-store',
      headers: { ...(await this.opts.headers()), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401) throw new UnauthorisedSync('sync: not authorised');
    if (!res.ok) throw new Error(`sync: HTTP ${res.status}`);
    const reply = (await res.json()) as unknown;
    const problems = validateSyncResponse(reply);
    if (problems.length) throw new Error(`sync: ${problems.join('; ')}`);
    return (reply as SyncResponse).socketTicket;
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
        // It may have missed a nudge while it was down.
        this.opts.onNudge();
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
        const problems = validateServerSocketMessage(msg);
        if (problems.length) return console.warn('[sf] socket: ignored a message:', problems.join('; '));
        this.handle(msg as ServerSocketMessage, ws);
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
