/**
 * The fixture server: the built player at `/`, a content directory at `/content/` (manifest,
 * blobs, data snapshots) held in memory, and a supervisor at `/supervisor/` that has nothing to
 * give. Tests change content with `publish`, and make any path fail or stall with `intercept`.
 * Every request is logged, with whether the client gave up on it.
 *
 * `/content/` also plays the device API (M3-06, M3-07): `POST /content/sync` answers as the API's
 * sync does (server time, acknowledged play counts per epoch, snapshots newer than the screen holds,
 * queued commands, a ticket), and `/content/ws` accepts a WebSocket that answers `ping` with `pong`
 * as the Durable Object does.
 * Tests `push` socket messages and read what the player sent in `socketMessages`. Content is
 * answered with CORS headers, so a test can serve it from another origin (`localUrl`), the way the
 * player meets the API.
 *
 * Pairing (M3-08): the supervisor holds `supervisorCredential` and the device API base it is bound
 * to, `supervisorApi` (GET, and POST or DELETE with its token, as device/pi/supervisor.py does). At
 * first they are `FIXTURE_CREDENTIAL` and this server's own API, `deviceApi`. Requests to the API origin (`localUrl`) need a bearer
 * credential in `authorised`; `/content/pair/start` and `/content/pair/poll` hand out codes, which a
 * test `claim`s. `revoke` refuses a credential and tells the sockets.
 *
 * A browser test screen (M3-41) meets the API on its own origin, beside a user's session cookie:
 * `sameOriginApi` makes the player's origin the API too, which, as /v1/device does, refuses any
 * request but the socket's that carries `sf.session_token`.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { extname, join, normalize } from 'node:path';
import type { DeviceCommand, PlayCount, SyncRequest } from '@signforge/contract';
import type { Content } from './content';

export type Action =
  /** Answer with this status and an empty body. */
  | { status: number }
  /** Send the headers and half the body, then nothing more, until the client gives up. */
  | 'stall'
  /** Send the body at this many bytes a second, so a download takes a while. */
  | { bytesPerSecond: number };

export interface RequestRecord {
  path: string;
  status: number;
  ifNoneMatch?: string;
  /** When the request arrived, `Date.now()`. */
  at: number;
  /** When the client closed the connection before the response finished (an abort), else undefined. */
  abortedAt?: number;
  /** The bearer credential the request carried, if any. */
  bearer?: string;
}

/** The credential the supervisor holds when a test starts: accepted by the API. */
export const FIXTURE_CREDENTIAL = `sfd_scr_fixture.${'A'.repeat(43)}`;
const SUPERVISOR_TOKEN = 'fixture-supervisor-token';

interface Pairing {
  /** What the screen said it is at start. */
  kind?: string;
  code: string;
  pollToken: string;
  expiresAt: number;
  credential?: string;
  collected?: boolean;
}

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

export class FixtureServer {
  readonly requests: RequestRecord[] = [];
  private content?: Content;
  /** Content whose files are served beside the published content's: a screen's last good manifest. */
  private lastGood?: Content;
  private data = new Map<string, unknown>();
  private rules: { match: RegExp; action: Action }[] = [];
  private server = createServer((req, res) => this.handle(req, res));
  private sockets = new Set<Socket>();
  /** Text messages the player sent over its sockets, other than keepalive pings. */
  readonly socketMessages: unknown[] = [];
  /** How many sockets the player has opened, in all. */
  socketsOpened = 0;
  /** Every sync request's body, oldest first. */
  readonly syncs: SyncRequest[] = [];
  /** Play counts stored by syncs, as the API stores them: a seq already stored in its epoch adds nothing. */
  readonly playCounts: PlayCount[] = [];
  private acked = new Map<string, number>();
  /** Added to the real time in the sync's `serverTime`: the device clock is that far wrong. */
  serverOffsetMs = 0;
  /** The sync's `nextSyncS`. */
  nextSyncS = 300;
  /** Commands the next sync carries, once. */
  readonly commands: DeviceCommand[] = [];
  /** Syncs carrying play counts to process and then drop without an answer, as a lost response would be. */
  loseCountReplies = 0;
  /** What the supervisor holds; undefined is a freshly flashed screen. */
  supervisorCredential: string | undefined = FIXTURE_CREDENTIAL;
  /** The device API base the supervisor's credential is bound to: `deviceApi` once started. */
  supervisorApi: string | undefined;
  /** Credentials the API accepts. */
  readonly authorised = new Set<string>([FIXTURE_CREDENTIAL]);
  /** Every code handed out, oldest first. */
  readonly pairings: Pairing[] = [];
  /** How long a new code lasts. */
  pairingTtlMs = 15 * 60_000;
  /** The API on the player's own origin too, as on the CMS's hostname. */
  sameOriginApi = false;

  private constructor(private readonly playerDir: string) {
    this.server.on('upgrade', (req, socket: Socket) => this.upgrade(req, socket));
  }

  static async start(playerDir: string): Promise<FixtureServer> {
    const s = new FixtureServer(playerDir);
    await new Promise<void>((r) => s.server.listen(0, '127.0.0.1', r));
    s.supervisorApi = s.deviceApi;
    return s;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** The same server under another origin (`localhost`): content there is cross-origin to the player. */
  get localUrl(): string {
    return `http://localhost:${(this.server.address() as AddressInfo).port}`;
  }

  /** The device API base this server plays: content on `localUrl`, where requests need a credential. */
  get deviceApi(): string {
    return `${this.localUrl}/content`;
  }

  /** Sockets open now. */
  get openSockets(): number {
    return this.sockets.size;
  }

  /** Send a message to every open socket. */
  push(msg: unknown): void {
    for (const s of this.sockets) s.write(frame(JSON.stringify(msg)));
  }

  /** Drop every open socket without a close frame, as a lost network would. */
  dropSockets(): void {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }

  /** Serve this content's files too, as the device API serves the last good manifest a screen reports. */
  serveLastGood(content: Content): void {
    this.lastGood = content;
  }

  /** Serve this content from now on. The player sees it at its next poll. */
  publish(content: Content): void {
    this.content = content;
  }

  /** Serve this snapshot at `/content/data/<id>.json`, and send it on sync to a screen that holds an older one. */
  setData(id: string, snapshot: unknown): void {
    this.data.set(id, snapshot);
  }

  /** Answer requests whose path matches with `action` instead. Returns a function that removes the rule. */
  intercept(match: RegExp, action: Action): () => void {
    const rule = { match, action };
    this.rules.push(rule);
    return () => void (this.rules = this.rules.filter((r) => r !== rule));
  }

  /** Total plays and ms the syncs stored, by `hour spot`. */
  storedCounts(): Record<string, { plays: number; ms: number }> {
    const out: Record<string, { plays: number; ms: number }> = {};
    for (const c of this.playCounts) {
      const t = (out[`${c.hour} ${c.spot}`] ??= { plays: 0, ms: 0 });
      t.plays += c.plays;
      t.ms += c.ms;
    }
    return out;
  }

  /** Claim a code the screen shows, as claim_screen does. Returns the credential its next poll collects. */
  claim(code: string): string {
    const p = this.pairings.find((x) => x.code === code && !x.credential && x.expiresAt > Date.now());
    if (!p) throw new Error(`no open pairing code ${code}`);
    p.credential = `sfd_scr_paired${this.pairings.indexOf(p)}.${'B'.repeat(43)}`;
    this.authorised.add(p.credential);
    return p.credential;
  }

  /** Revoke a credential, as revoke_screen_credential does: refused from now on, and its sockets told. */
  revoke(credential: string): void {
    this.authorised.delete(credential);
    this.push({ type: 'revoked' });
  }

  /** Requests whose path matches, oldest first. */
  requestsTo(match: RegExp): RequestRecord[] {
    return this.requests.filter((r) => match.test(r.path));
  }

  async close(): Promise<void> {
    this.dropSockets();
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    const inm = req.headers['if-none-match'];
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    const rec: RequestRecord = { path, status: 0, at: Date.now(), ...(inm ? { ifNoneMatch: String(inm) } : {}), ...(bearer ? { bearer } : {}) };
    this.requests.push(rec);
    res.on('close', () => {
      if (!res.writableFinished) rec.abortedAt = Date.now();
    });
    const rule = this.rules.find((r) => r.match.test(path));
    const send = (status: number, body?: Buffer | string, type = 'application/octet-stream') => {
      rec.status = status;
      res.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
        ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}),
      });
      if (rule && typeof rule.action === 'object' && 'bytesPerSecond' in rule.action && body) {
        const buf = Buffer.from(body);
        const chunk = 64 * 1024;
        const every = (1000 * chunk) / rule.action.bytesPerSecond;
        let at = 0;
        const next = () => {
          if (res.destroyed) return;
          res.write(buf.subarray(at, (at += chunk)));
          if (at >= buf.byteLength) res.end();
          else setTimeout(next, every);
        };
        return next();
      }
      if (rule?.action === 'stall' && body) {
        const buf = Buffer.from(body);
        res.write(buf.subarray(0, Math.floor(buf.byteLength / 2)));
        return; // and nothing more, until the client gives up
      }
      res.end(body);
    };
    if (path.startsWith('/content/')) {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-expose-headers', 'etag');
      if (req.method === 'OPTIONS') {
        res.setHeader('access-control-allow-headers', 'authorization, if-none-match, content-type');
        res.setHeader('access-control-allow-methods', 'GET, POST');
        return send(204);
      }
    }
    if (rule && typeof rule.action === 'object' && 'status' in rule.action) return send(rule.action.status, '');

    if (path.startsWith('/supervisor/')) return this.supervisor(req, path.slice('/supervisor/'.length), send);
    if (path.startsWith('/content/')) {
      const rest = path.slice('/content/'.length);
      const c = this.content;
      if (req.headers.cookie?.includes('sf.session_token=')) return send(401, JSON.stringify({ error: 'session_not_accepted' }), 'application/json');
      if (rest === 'pair/start' && req.method === 'POST') {
        return void readBody(req).then((body) => {
          const p: Pairing = {
            kind: body ? (JSON.parse(body) as { kind?: string }).kind : undefined,
            code: `P${String(this.pairings.length).padStart(5, '0')}`,
            pollToken: `poll-${this.pairings.length}`,
            expiresAt: Date.now() + this.pairingTtlMs,
          };
          this.pairings.push(p);
          send(200, JSON.stringify({ code: p.code, pollToken: p.pollToken, expiresAt: new Date(p.expiresAt).toISOString() }), 'application/json');
        });
      }
      if (rest === 'pair/poll' && req.method === 'POST') {
        return void readBody(req).then((body) => {
          const token = (JSON.parse(body) as { pollToken?: string }).pollToken;
          const p = this.pairings.find((x) => x.pollToken === token);
          const reply =
            p?.credential && !p.collected
              ? ((p.collected = true), { status: 'paired', screenId: p.credential.slice(4, p.credential.indexOf('.')), credential: p.credential })
              : p && !p.credential && p.expiresAt > Date.now()
                ? { status: 'waiting' }
                : { status: 'expired' };
          send(200, JSON.stringify(reply), 'application/json');
        });
      }
      // The API origin needs a live credential, as /v1/device does.
      if ((this.sameOriginApi || req.headers.host?.startsWith('localhost')) && !(bearer && this.authorised.has(bearer))) return send(401, '');
      if (rest === 'sync' && req.method === 'POST') {
        let body = '';
        req.on('data', (d: Buffer) => (body += d));
        req.on('end', () => {
          const sync = JSON.parse(body) as SyncRequest;
          this.syncs.push(sync);
          const acked = this.acked.get(sync.epoch) ?? 0;
          if (sync.seq > acked) {
            this.playCounts.push(...sync.playCounts);
            this.acked.set(sync.epoch, sync.seq);
          }
          const held = sync.snapshots ?? {};
          const all = [...this.data.values()] as { id: string; version: number; checkedAt: string }[];
          const snapshots = all.filter((snap) => snap.version > (held[snap.id] ?? -1));
          // As the API does: when each snapshot the screen holds at its version was last checked.
          const checked = Object.fromEntries(
            all.filter((snap) => snap.version === held[snap.id]).map((snap) => [snap.id, { version: snap.version, checkedAt: snap.checkedAt }]),
          );
          const reply = {
            serverTime: new Date(Date.now() + this.serverOffsetMs).toISOString(),
            nextSyncS: this.nextSyncS,
            epoch: sync.epoch,
            ackSeq: this.acked.get(sync.epoch) ?? 0,
            ...(c ? { desiredManifest: c.manifest.id } : {}),
            snapshots,
            checked,
            socketTicket: `ticket-${this.syncs.length}`,
            commands: this.commands.splice(0),
          };
          if (sync.playCounts.length && this.loseCountReplies > 0) {
            this.loseCountReplies--;
            rec.status = 0;
            return void req.socket.destroy();
          }
          send(200, JSON.stringify(reply), 'application/json');
        });
        return;
      }
      if (rest === 'manifest.json') {
        if (!c) return send(404, '');
        if (inm === `"${c.manifest.id}"`) return send(304);
        return send(200, JSON.stringify(c.manifest), 'application/json');
      }
      const blob = /^blobs\/([0-9a-f]{64})$/.exec(rest);
      if (blob) {
        const body = c?.blobs.get(blob[1]!) ?? this.lastGood?.blobs.get(blob[1]!);
        return body ? send(200, body) : send(404, '');
      }
      const data = /^data\/([^/]+)\.json$/.exec(rest);
      if (data && this.data.has(data[1]!)) return send(200, JSON.stringify(this.data.get(data[1]!)), 'application/json');
      return send(404, '');
    }
    try {
      const file = join(this.playerDir, path === '/' ? 'index.html' : path);
      send(200, readFileSync(file), TYPES[extname(file)] ?? 'application/octet-stream');
    } catch {
      send(404, '');
    }
  }

  /** The supervisor's credential and token routes; everything else it has nothing for. */
  private supervisor(req: IncomingMessage, rest: string, send: (status: number, body?: string, type?: string) => void): void {
    const json = (status: number, body: unknown) => send(status, JSON.stringify(body), 'application/json');
    if (rest === 'token' && req.method === 'GET') return json(200, { token: SUPERVISOR_TOKEN });
    if (rest !== 'credential') return send(404, '');
    if (req.method === 'GET') {
      return this.supervisorCredential
        ? json(200, { credential: this.supervisorCredential, api: this.supervisorApi ?? null })
        : json(404, { error: 'no credential' });
    }
    if (req.headers['x-sf-token'] !== SUPERVISOR_TOKEN) return json(403, { error: 'forbidden' });
    if (req.method === 'DELETE') {
      this.supervisorCredential = undefined;
      this.supervisorApi = undefined;
      return json(200, {});
    }
    if (req.method === 'POST') {
      return void readBody(req).then((body) => {
        ({ credential: this.supervisorCredential, api: this.supervisorApi } = JSON.parse(body) as { credential: string; api: string });
        json(200, {});
      });
    }
    send(405, '');
  }

  /** A minimal WebSocket server: text frames, close, and `ping` answered with `pong`. */
  private upgrade(req: IncomingMessage, socket: Socket): void {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const rec: RequestRecord = { path, status: 101, at: Date.now() };
    this.requests.push(rec);
    const rule = this.rules.find((r) => r.match.test(path));
    const key = req.headers['sec-websocket-key'];
    const refuse = rule && typeof rule.action === 'object' && 'status' in rule.action ? rule.action.status : path === '/content/ws' && key ? 0 : 404;
    if (refuse) {
      rec.status = refuse;
      socket.end(`HTTP/1.1 ${refuse} Refused\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
      return;
    }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`);
    this.sockets.add(socket);
    this.socketsOpened++;
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => this.sockets.delete(socket));
    let buf = Buffer.alloc(0);
    socket.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const f = readFrame(buf);
        if (!f) return;
        buf = buf.subarray(f.length);
        if (f.opcode === 8) {
          socket.end(Buffer.from([0x88, 0]));
          this.sockets.delete(socket);
          return;
        }
        if (f.opcode !== 1) continue;
        const text = f.payload.toString('utf8');
        if (text === 'ping') socket.write(frame('pong'));
        else this.socketMessages.push(JSON.parse(text));
      }
    });
  }
}

/** An unmasked text frame, as a server sends. */
function frame(text: string): Buffer {
  const body = Buffer.from(text);
  const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
  return Buffer.concat([head, body]);
}

/** One frame from a client (always masked), or undefined until it has all arrived. */
function readFrame(buf: Buffer): { opcode: number; payload: Buffer; length: number } | undefined {
  if (buf.length < 2) return undefined;
  const opcode = buf[0]! & 15;
  let len = buf[1]! & 127;
  let at = 2;
  if (len === 126) {
    if (buf.length < 4) return undefined;
    len = buf.readUInt16BE(2);
    at = 4;
  } else if (len === 127) {
    if (buf.length < 10) return undefined;
    len = Number(buf.readBigUInt64BE(2));
    at = 10;
  }
  if (buf.length < at + 4 + len) return undefined;
  const mask = buf.subarray(at, at + 4);
  const payload = Buffer.from(buf.subarray(at + 4, at + 4 + len));
  for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
  return { opcode, payload, length: at + 4 + len };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d));
    req.on('end', () => resolve(body));
  });
}
