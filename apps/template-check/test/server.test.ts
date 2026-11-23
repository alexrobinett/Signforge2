/**
 * The runner's HTTP API, in Node as the container runs it. The network probe points at a local
 * port: closed (nothing listens) for the checks, open (a server answers) for the refusal.
 */
import { buildTemplate } from '@signforge/template-build';
import { validateTemplateRuntimeReport } from '@signforge/contract';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRunner } from '../src/runner/server';

const listening = async (s: Server) => {
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};
const close = (s: Server) => new Promise((resolve) => s.close(resolve));

let clock: { manifest: unknown; html: string };
beforeAll(async () => {
  clock = await buildTemplate(new URL('../../../templates/clock', import.meta.url).pathname);
});

describe('a runner with no network', () => {
  let runner: Server;
  let url: string;
  beforeAll(async () => {
    // A port nothing listens on: the probe fails as it does in the container.
    const free = createServer();
    const closed = await listening(free);
    await close(free);
    runner = await startRunner({ port: 0, image: 'test-image', probeUrls: [`${closed}/probe`] });
    url = `http://127.0.0.1:${(runner.address() as AddressInfo).port}`;
  });
  afterAll(() => close(runner));

  it('says so on /health, with the probe that failed', async () => {
    const health = await (await fetch(`${url}/health`)).json();
    expect(health).toMatchObject({ image: 'test-image', browser: expect.stringMatching(/^Chromium \d+/), network: { closed: true } });
    expect(health.network.detail).toMatch(/could not be reached/);
  });

  it('has proved at start that it still sees a blocked request: its canary was reported', async () => {
    const health = await (await fetch(`${url}/health`)).json();
    expect(health.canary).toEqual({ ok: true, problems: ["requested https://canary.invalid/a'b (blocked)"] });
  });

  it('checks a template and answers with a report the contract accepts', async () => {
    const res = await fetch(`${url}/check`, { method: 'POST', body: JSON.stringify(clock) });
    expect(res.status).toBe(200);
    const report = await res.json();
    expect(validateTemplateRuntimeReport(report)).toEqual([]);
    expect(report).toMatchObject({ ok: true, problems: [], runner: { image: 'test-image' }, cost: { startMs: 0 } });
    expect(report.cost.checkMs).toBeGreaterThan(0);
    expect(report.renders).toHaveLength(2);
  });

  it('refuses a body that is not a manifest and its HTML', async () => {
    const res = await fetch(`${url}/check`, { method: 'POST', body: JSON.stringify({ manifest: {}, html: 1 }) });
    expect(res.status).toBe(400);
  });
});

describe('a runner whose org has checks waiting', () => {
  it('refuses one more than it may hold, at once and to retry, and runs the rest', async () => {
    const free = createServer();
    const closed = await listening(free);
    await close(free);
    const runner = await startRunner({ port: 0, image: 'test-image', probeUrls: [`${closed}/probe`], maxPending: 2 });
    try {
      const url = `http://127.0.0.1:${(runner.address() as AddressInfo).port}`;
      const send = () => fetch(`${url}/check`, { method: 'POST', body: JSON.stringify(clock) });
      const [first, second, third] = await Promise.all([send(), send(), send()]);
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(third.status).toBe(503);
      expect(third.headers.get('retry-after')).toBe('30');
      expect((await third.json()).error).toBe("2 checks are already queued in this org's container; try again shortly");
    } finally {
      await close(runner);
    }
  });
});

/** A local port with nothing listening on it. */
async function closedPort() {
  const free = createServer();
  const url = await listening(free);
  await close(free);
  return url;
}

describe('a runner that can reach the network', () => {
  it('is open when any probe answers: a name that does not resolve does not hide an address that does', async () => {
    const outside = createServer((_req, res) => res.end('hello'));
    const address = `${await listening(outside)}/probe`;
    const runner = await startRunner({ port: 0, image: 'test-image', probeUrls: [`${await closedPort()}/name`, address] });
    try {
      const url = `http://127.0.0.1:${(runner.address() as AddressInfo).port}`;
      expect((await fetch(`${url}/check`, { method: 'POST', body: JSON.stringify(clock) })).status).toBe(503);
    } finally {
      await close(runner);
      await close(outside);
    }
  });

  it('is found open later too: the probe runs again, and checks are refused once it answers', async () => {
    const later = await closedPort();
    const runner = await startRunner({ port: 0, image: 'test-image', probeUrls: [`${later}/probe`], probeEveryMs: 200 });
    const outside = createServer((_req, res) => res.end('hello'));
    try {
      const url = `http://127.0.0.1:${(runner.address() as AddressInfo).port}`;
      expect((await (await fetch(`${url}/health`)).json()).network.closed).toBe(true);
      await new Promise<void>((resolve) => outside.listen(Number(new URL(later).port), '127.0.0.1', resolve));
      await new Promise((r) => setTimeout(r, 600));
      const res = await fetch(`${url}/check`, { method: 'POST', body: JSON.stringify(clock) });
      expect(res.status).toBe(503);
      expect((await res.json()).error).toMatch(/can reach the network/);
    } finally {
      await close(runner);
      await close(outside);
    }
  });

  it('refuses the checks it had already admitted once the probe answers, the one rendering included', async () => {
    const later = await closedPort();
    const runner = await startRunner({ port: 0, image: 'test-image', probeUrls: [`${later}/probe`], probeEveryMs: 200 });
    const outside = createServer((_req, res) => res.end('hello'));
    try {
      const url = `http://127.0.0.1:${(runner.address() as AddressInfo).port}`;
      const admitted = [1, 2, 3].map(() => fetch(`${url}/check`, { method: 'POST', body: JSON.stringify(clock) }));
      // The first is rendering (a check takes about 2.8 s) when the network opens.
      await new Promise((r) => setTimeout(r, 400));
      await new Promise<void>((resolve) => outside.listen(Number(new URL(later).port), '127.0.0.1', resolve));
      const answers = await Promise.all(admitted);
      expect(answers.map((r) => r.status)).toEqual([503, 503, 503]);
      for (const r of answers) expect((await r.json()).error).toMatch(/can reach the network/);
    } finally {
      await close(runner);
      await close(outside);
    }
  });

  it('refuses every check', async () => {
    const outside = createServer((_req, res) => res.end('hello'));
    const probeUrl = `${await listening(outside)}/probe`;
    const runner = await startRunner({ port: 0, image: 'test-image', probeUrls: [probeUrl] });
    try {
      const url = `http://127.0.0.1:${(runner.address() as AddressInfo).port}`;
      const res = await fetch(`${url}/check`, { method: 'POST', body: JSON.stringify(clock) });
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe(`the check container can reach the network (${probeUrl} answered 200); it must not`);
    } finally {
      await close(runner);
      await close(outside);
    }
  });
});
