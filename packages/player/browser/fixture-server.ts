/**
 * The fixture server: the built player at `/`, a content directory at `/content/` (manifest,
 * blobs, data snapshots) held in memory, and a supervisor at `/supervisor/` that has nothing to
 * give. Tests change content with `publish`, and make any path fail or stall with `intercept`.
 * Every request is logged, with whether the client gave up on it.
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';
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
}

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

export class FixtureServer {
  readonly requests: RequestRecord[] = [];
  private content?: Content;
  private data = new Map<string, unknown>();
  private rules: { match: RegExp; action: Action }[] = [];
  private server = createServer((req, res) => this.handle(req, res));

  private constructor(private readonly playerDir: string) {}

  static async start(playerDir: string): Promise<FixtureServer> {
    const s = new FixtureServer(playerDir);
    await new Promise<void>((r) => s.server.listen(0, '127.0.0.1', r));
    return s;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** Serve this content from now on. The player sees it at its next poll. */
  publish(content: Content): void {
    this.content = content;
  }

  /** Serve this snapshot at `/content/data/<id>.json`. */
  setData(id: string, snapshot: unknown): void {
    this.data.set(id, snapshot);
  }

  /** Answer requests whose path matches with `action` instead. Returns a function that removes the rule. */
  intercept(match: RegExp, action: Action): () => void {
    const rule = { match, action };
    this.rules.push(rule);
    return () => void (this.rules = this.rules.filter((r) => r !== rule));
  }

  /** Requests whose path matches, oldest first. */
  requestsTo(match: RegExp): RequestRecord[] {
    return this.requests.filter((r) => match.test(r.path));
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    const inm = req.headers['if-none-match'];
    const rec: RequestRecord = { path, status: 0, at: Date.now(), ...(inm ? { ifNoneMatch: String(inm) } : {}) };
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
    if (rule && typeof rule.action === 'object' && 'status' in rule.action) return send(rule.action.status, '');

    if (path.startsWith('/supervisor/')) return send(404, '');
    if (path.startsWith('/content/')) {
      const rest = path.slice('/content/'.length);
      const c = this.content;
      if (rest === 'manifest.json') {
        if (!c) return send(404, '');
        if (inm === `"${c.manifest.id}"`) return send(304);
        return send(200, JSON.stringify(c.manifest), 'application/json');
      }
      const blob = /^blobs\/([0-9a-f]{64})$/.exec(rest);
      if (blob) {
        const body = c?.blobs.get(blob[1]!);
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
}
