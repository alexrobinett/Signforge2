// The built-in agent's Anthropic adapter and its key (#261): sealed for one org and provider, opened
// only to call the provider, and never in a result, a refusal or a log line. No network: fetch is
// stubbed with Anthropic's Models API answers.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiProviders } from '../src/agent/provider';

const KEY = 'sk-ant-api03-SECRETKEYSECRETKEYSECRET-7Q2c';
const ORG = { orgId: 'org-a', provider: 'anthropic' as const };
const DEV = { ENVIRONMENT: 'dev', CONNECTION_KEY: undefined, ANTHROPIC_BASE_URL: undefined };
const PROD = { ENVIRONMENT: 'prod', CONNECTION_KEY: 'k'.repeat(64), ANTHROPIC_BASE_URL: 'https://stub.test' };

/** Anthropic's Models API, answering `status` (and its list for a 200), recording what it was asked. */
function anthropic(status: number) {
  const asked: { url: string; key: string | null }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    asked.push({ url: request.url, key: request.headers.get('authorization') });
    if (status !== 200) return Response.json({ type: 'error', error: { type: 'some_error', message: `refused ${KEY}` } }, { status });
    return Response.json({
      data: [
        { type: 'model', id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', created_at: '2026-10-01T00:00:00Z' },
        { type: 'model', id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', created_at: '2026-10-01T00:00:00Z' },
      ],
      has_more: false,
      first_id: 'claude-haiku-5-5',
      last_id: 'claude-sonnet-5-5',
    });
  };
  return { fetch, asked };
}

afterEach(() => vi.restoreAllMocks());

describe('the AI provider service', () => {
  it("tests a sealed key with Anthropic's model list, sent only to Anthropic, and gives back the exact ids", async () => {
    const { fetch, asked } = anthropic(200);
    // A deployed API ignores ANTHROPIC_BASE_URL.
    const service = aiProviders(PROD, fetch);
    const sealed = await service.seal(ORG, KEY);
    expect(sealed).not.toContain('SECRETKEY');
    expect(await service.test(ORG, sealed)).toEqual({ ok: true, models: ['claude-haiku-5-5', 'claude-sonnet-5-5'] });
    expect(asked).toEqual([{ url: 'https://api.anthropic.com/v1/models?limit=100', key: `Bearer ${KEY}` }]);
  });

  it('opens a key only for the org and provider it was sealed for', async () => {
    const { fetch, asked } = anthropic(200);
    const service = aiProviders(DEV, fetch);
    const sealed = await service.seal(ORG, KEY);
    expect(await service.test({ ...ORG, orgId: 'org-b' }, sealed)).toEqual({ ok: false, problem: 'refused' });
    expect(asked).toEqual([]);
  });

  it('says in a word why a test failed, never the body or the key, and logs nothing', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info'), vi.spyOn(console, 'debug')];
    for (const [status, problem] of [
      [401, 'refused'],
      [403, 'refused'],
      [429, 'busy'],
      [500, 'busy'],
      [529, 'busy'],
      [404, 'unreachable'],
    ] as const) {
      const service = aiProviders(DEV, anthropic(status).fetch);
      const result = await service.test(ORG, await service.seal(ORG, KEY));
      expect(result, String(status)).toEqual({ ok: false, problem });
    }
    const offline = aiProviders(DEV, async () => {
      throw new TypeError(`network down ${KEY}`);
    });
    expect(await offline.test(ORG, await offline.seal(ORG, KEY))).toEqual({ ok: false, problem: 'unreachable' });
    for (const log of logs) expect(JSON.stringify(log.mock.calls)).not.toContain('SECRETKEY');
  });

  it('sends a dev API to ANTHROPIC_BASE_URL, as the CMS e2e does with its stub', async () => {
    const { fetch, asked } = anthropic(200);
    const service = aiProviders({ ...DEV, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/stub' }, fetch);
    await service.test(ORG, await service.seal(ORG, KEY));
    expect(asked.map((a) => a.url)).toEqual(['http://127.0.0.1:9/stub/v1/models?limit=100']);
  });
});
