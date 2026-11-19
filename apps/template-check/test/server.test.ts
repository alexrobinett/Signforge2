/**
 * The runner's HTTP API, in Node as the container runs it. The network probe points at a local
 * port: closed (nothing listens) for the checks, open (a server answers) for the refusal.
 */
import { buildTemplate } from '@signforge/cli/template';
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
    runner = await startRunner({ port: 0, image: 'test-image', probeUrl: `${closed}/probe` });
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

describe('a runner that can reach the network', () => {
  it('refuses every check', async () => {
    const outside = createServer((_req, res) => res.end('hello'));
    const probeUrl = `${await listening(outside)}/probe`;
    const runner = await startRunner({ port: 0, image: 'test-image', probeUrl });
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
