import { env } from 'cloudflare:workers';
import { getMigrations } from 'better-auth/db/migration';
import { describe, expect, it } from 'vitest';
import { authOptions } from '../src/auth/options';
import { CloudflareEmailSender, RecordingEmailSender } from '../src/email';
import { Client, email, testApp } from './client';

describe('rate limiting', () => {
  it('is kept in D1, so it holds across a restart', async () => {
    const addr = email('limited');
    const ip = '203.0.113.7';
    const send = (c: Client) => c.post('/api/auth/email-otp/send-verification-otp', { email: addr, type: 'sign-in' });

    // Better Auth allows three codes a minute per IP.
    const before = new Client(testApp(), ip);
    for (let i = 0; i < 3; i++) expect((await send(before)).status).toBe(200);
    expect((await send(before)).status).toBe(429);

    // A new app, as a fresh isolate would build it, with nothing carried over in memory.
    const after = new Client(testApp(), ip);
    const res = await send(after);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('x-retry-after'))).toBeGreaterThan(0);
    expect(after.t.outbox.messages).toHaveLength(0);

    const row = await env.DB.prepare('SELECT count FROM rateLimit WHERE key LIKE ?').bind(`%${ip}%send-verification-otp%`).first<{ count: number }>();
    expect(row?.count).toBe(3);

    // Another address is not limited.
    expect((await send(new Client(testApp(), '203.0.113.8'))).status).toBe(200);
  });
});

describe('GitHub sign-in', () => {
  const withGithub = { ...env, GITHUB_CLIENT_ID: 'gh-client-id', GITHUB_CLIENT_SECRET: 'gh-client-secret' } as Env;

  it('redirects to GitHub with the configured client, without calling GitHub', async () => {
    const c = new Client(testApp(), undefined, withGithub);
    const res = await c.post('/api/auth/sign-in/social', { provider: 'github', callbackURL: '/' });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(u.searchParams.get('client_id')).toBe('gh-client-id');
    expect(u.searchParams.get('redirect_uri')).toBe('https://api.test/api/auth/callback/github');
    expect(u.searchParams.get('state')).toBeTruthy();
  });

  it('is not offered when the secrets are missing', async () => {
    const res = await new Client(testApp()).post('/api/auth/sign-in/social', { provider: 'github', callbackURL: '/' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('email', () => {
  it('sends through the Cloudflare binding from the configured address', async () => {
    const sent: unknown[] = [];
    const binding = { send: async (m: unknown) => (sent.push(m), { messageId: 'm1' }) } as unknown as SendEmail;
    await new CloudflareEmailSender(binding, 'SignForge <no-reply@example.com>').send({ to: 'a@example.com', subject: 'Hi', text: 'Body' });
    expect(sent).toEqual([{ from: 'SignForge <no-reply@example.com>', to: 'a@example.com', subject: 'Hi', text: 'Body' }]);
  });

  it('records in dev', async () => {
    const r = new RecordingEmailSender();
    await r.send({ to: 'a@example.com', subject: 'One', text: '1' });
    await r.send({ to: 'a@example.com', subject: 'Two', text: '2' });
    expect(r.last('a@example.com')?.subject).toBe('Two');
    expect(r.last('b@example.com')).toBeUndefined();
  });
});

describe("packages/db's migrations", () => {
  it('hold every table and column Better Auth needs for our options', async () => {
    const plan = await getMigrations({
      ...authOptions({
        email: new RecordingEmailSender(),
        appUrl: 'https://cms.test',
        audit: async () => {},
        startingOrg: async () => null,
        mcpResource: 'https://cms.test/mcp',
        grants: { create: async () => ({ ok: false, refused: 'not_a_member' }), revokeMember: async () => {} },
        consent: { complete: async () => ({ redirect: false, url: '' }) },
      }),
      database: env.DB,
    });
    expect(plan.toBeCreated.map((t) => t.table)).toEqual([]);
    expect(plan.toBeAdded.map((t) => `${t.table}: ${Object.keys(t.fields).join(', ')}`)).toEqual([]);
    expect(plan.toBeAddedIndexes.map((i) => i.name)).toEqual([]);
    expect(plan.schemaProblems).toEqual([]);
  });
});
