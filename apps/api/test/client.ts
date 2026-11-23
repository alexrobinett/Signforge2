/**
 * Test helpers: the `/api` app with a recording email sender, and a client that keeps cookies
 * the way a browser does. With the session cookie cache on, a client must take every cookie a
 * response sets (notably `setActiveOrganization`'s), or the server still sees the old cache.
 */
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { expect } from 'vitest';
import type { AgentDeps } from '../src/agent/inline';
import { createApi } from '../src/api';
import type { ConnectorDeps } from '../src/connectors';
import { RecordingEmailSender } from '../src/email';

export const ORIGIN = 'https://api.test';

/** A fresh `/api` app, as a new isolate would build it; with `connectors`, reaching those providers (test/fake-provider.ts), and with `agent`, a stub model. */
export function testApp({
  outbox = new RecordingEmailSender(),
  connectors,
  agent,
}: {
  outbox?: RecordingEmailSender;
  connectors?: ConnectorDeps;
  agent?: AgentDeps;
} = {}) {
  const api = createApi({ email: outbox, connectors, agent });
  const app = new Hono<{ Bindings: Env }>().route('/api', api);
  return { app, outbox };
}

type App = ReturnType<typeof testApp>;

let ipCounter = 0;
/** A distinct client address, so Better Auth's per-IP limits do not couple tests. */
export const nextIp = () => `10.9.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

export class Client {
  readonly jar = new Map<string, string>();
  /** Each request's context, so `settled` can wait for the work it left running (`waitUntil`). */
  private readonly contexts: ExecutionContext[] = [];
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
    const ctx = createExecutionContext();
    this.contexts.push(ctx);
    const res = await this.t.app.request(
      `${ORIGIN}${path}`,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
      this.bindings,
      ctx,
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

  /** Wait for what this client's requests left running after their responses. */
  async settled() {
    await Promise.all(this.contexts.splice(0).map(waitOnExecutionContext));
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

/**
 * The bindings, with each rate limit of wrangler.jsonc counted on the tests' clock (`vi.setSystemTime`), so a
 * rate limit test says which minute each call falls in. Miniflare's limiters count in windows fixed to the real
 * clock (each minute from :00), in another service the tests' clock does not reach, so a test against them
 * failed whenever its calls straddled a minute (#161). These count the same way: a key's first `limit` calls
 * in each `period` window pass. Each call of this starts new counts.
 */
export function clockLimits(): Env {
  const limits: Record<string, { limit: number; period: number }> = JSON.parse(env.RATE_LIMITS);
  const limiters = Object.entries(limits).map(([name, { limit, period }]): [string, RateLimit] => {
    const counts = new Map<string, number>();
    return [
      name,
      {
        limit: async ({ key }) => {
          const window = `${Math.floor(Date.now() / (period * 1000))} ${key}`;
          const n = counts.get(window) ?? 0;
          if (n >= limit) return { success: false };
          counts.set(window, n + 1);
          return { success: true };
        },
      },
    ];
  });
  return { ...env, ...Object.fromEntries(limiters) };
}
