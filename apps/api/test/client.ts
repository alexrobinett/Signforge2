/**
 * Test helpers: the `/api` app with a recording email sender, and a client that keeps cookies
 * the way a browser does. With the session cookie cache on, a client must take every cookie a
 * response sets (notably `setActiveOrganization`'s), or the server still sees the old cache.
 */
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { expect } from 'vitest';
import { createApi } from '../src/api';
import { RecordingEmailSender } from '../src/email';

export const ORIGIN = 'https://api.test';

export type Api = ReturnType<typeof createApi>;

/** A fresh `/api` app, as a new isolate would build it. */
export function testApp({ outbox = new RecordingEmailSender() }: { outbox?: RecordingEmailSender } = {}) {
  const api = createApi({ email: outbox });
  const app = new Hono<{ Bindings: Env }>().route('/api', api);
  return { app, outbox };
}

type App = ReturnType<typeof testApp>;

let ipCounter = 0;
/** A distinct client address, so Better Auth's per-IP limits do not couple tests. */
export const nextIp = () => `10.9.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

export class Client {
  readonly jar = new Map<string, string>();
  constructor(
    public t: App,
    readonly ip = nextIp(),
    private readonly bindings: Env = env,
  ) {}

  get cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    const headers = new Headers({ 'cf-connecting-ip': this.ip, origin: ORIGIN, ...extra });
    if (this.jar.size) headers.set('cookie', this.cookie);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const res = await this.t.app.request(
      `${ORIGIN}${path}`,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
      this.bindings,
    );
    for (const c of res.headers.getSetCookie()) {
      const [pair = '', ...attrs] = c.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1);
      if (!value || attrs.some((a) => /^\s*max-age=0\s*$/i.test(a))) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return res;
  }

  get = (path: string, extra?: Record<string, string>) => this.request('GET', path, undefined, extra);
  post = (path: string, body: unknown = {}, extra?: Record<string, string>) => this.request('POST', path, body, extra);
  patch = (path: string, body: unknown, extra?: Record<string, string>) => this.request('PATCH', path, body, extra);

  /** Call a tool through `POST /api/tools/:name`. */
  tool = (name: string, input: unknown = {}, extra?: Record<string, string>) => this.post(`/api/tools/${name}`, input, extra);

  /** POST and expect 2xx; returns the JSON body. */
  async ok<T = any>(path: string, body: unknown = {}): Promise<T> {
    const res = await this.post(path, body);
    const text = await res.text();
    expect(res.status, `${path}: ${text}`).toBeLessThan(300);
    return (text ? JSON.parse(text) : null) as T;
  }

  /** The six-digit code in the newest email to `email`. */
  codeFor(email: string) {
    const m = this.t.outbox.last(email)?.text.match(/\b(\d{6})\b/);
    if (!m) throw new Error(`no code emailed to ${email}`);
    return m[1]!;
  }

  /** Sign in (or up) by email code. */
  async signIn(email: string) {
    await this.ok('/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' });
    return this.ok<{ user: { id: string; email: string } }>('/api/auth/sign-in/email-otp', { email, otp: this.codeFor(email) });
  }

  async session() {
    const res = await this.get('/api/session');
    return { status: res.status, body: (await res.json()) as any };
  }

  async createOrg(name: string) {
    const slug = `${name.toLowerCase().replace(/\W+/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
    return this.ok<{ id: string; slug: string }>('/api/auth/organization/create', { name, slug });
  }

  setActive(organizationId: string) {
    return this.post('/api/auth/organization/set-active', { organizationId });
  }
}

let n = 0;
export const email = (who: string) => `${who}-${Date.now().toString(36)}-${++n}@signforge.test`;
