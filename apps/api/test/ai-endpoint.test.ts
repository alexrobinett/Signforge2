// An OpenAI-compatible endpoint's key and address (#262): every request goes through the fetch
// guards, the first and each redirect's, a redirect never takes the key to another origin, a key
// opens only for the address it was sealed for, and nothing in process.env changes where a
// request goes or what it carries. No network: fetch and DNS are stubbed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiProviders } from '../src/agent/provider';
import type { FetchGuards } from '../src/data/fetch';

const KEY = 'sk-endpoint-SECRETKEYSECRETKEYSECRET-0001';
const BASE = 'https://models.example.com/v1';
const ORG = { orgId: 'org-a', provider: 'openai-compatible' as const, baseUrl: BASE };
const PROD = { ENVIRONMENT: 'prod', CONNECTION_KEY: 'k'.repeat(64), ANTHROPIC_BASE_URL: undefined, FEED_STUB_URL: undefined };
const PUBLIC = '93.184.215.14';
const MODELS = {
  object: 'list',
  data: [
    { id: 'model-a', object: 'model' },
    { id: 'model-b', object: 'model' },
  ],
};

/** The endpoint: `answer` per URL (a JSON body, a status, or a redirect), each request recorded with its key. */
function endpoint(answer: (url: string) => Response, addresses: (host: string, call: number) => string[] = () => [PUBLIC]) {
  const asked: { url: string; auth: string | null; apiKey: string | null }[] = [];
  const resolved: string[] = [];
  const guards: FetchGuards = {
    resolve: async (host) => {
      resolved.push(host);
      return addresses(host, resolved.filter((h) => h === host).length);
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      asked.push({ url: request.url, auth: request.headers.get('authorization'), apiKey: request.headers.get('x-api-key') });
      return answer(request.url);
    },
  };
  // Only the guards reach the endpoint: a fetch outside them fails the test.
  const service = aiProviders(PROD, () => Promise.reject(new Error('fetched outside the guards')), guards);
  return { service, asked, resolved };
}
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });
const test = async (service: ReturnType<typeof aiProviders>, key = ORG) => service.test(key, await service.seal(key, KEY));

afterEach(() => vi.restoreAllMocks());

describe('an OpenAI-compatible endpoint', () => {
  it('lists its models at <base>/models with the key as a Bearer token, through the guards', async () => {
    const { service, asked, resolved } = endpoint(() => Response.json(MODELS));
    expect(await test(service)).toEqual({ ok: true, models: ['model-a', 'model-b'] });
    expect(asked).toEqual([{ url: `${BASE}/models`, auth: `Bearer ${KEY}`, apiKey: null }]);
    expect(resolved).toEqual(['models.example.com']);
  });

  it('is refused, unread, at an address that resolves to a private, loopback, link-local or metadata address, #236 forms included', async () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      'fe80::1',
      'fd00::1',
      'fec0::1',
      '::ffff:7f00:1',
      '::ffff:127.0.0.1',
      '2002:7f00:1::',
      '2001::1',
      '64:ff9b::7f00:1',
    ]) {
      const { service, asked } = endpoint(
        () => Response.json(MODELS),
        () => [address],
      );
      expect(await test(service), address).toEqual({ ok: false, problem: 'blocked' });
      expect(asked, address).toEqual([]);
    }
  });

  it('is refused, unread, at an address that is not public https, whatever the tool let through', async () => {
    for (const baseUrl of [
      'http://models.example.com/v1',
      'https://127.0.0.1/v1',
      'https://[::1]/v1',
      'https://models.example.com:8443/v1',
      'https://localhost/v1',
    ]) {
      const { service, asked } = endpoint(() => Response.json(MODELS));
      expect(await test(service, { ...ORG, baseUrl }), baseUrl).toEqual({ ok: false, problem: 'blocked' });
      expect(asked, baseUrl).toEqual([]);
    }
  });

  it("sends the key to no URL with a user name or password, the first or a redirect's, whatever the tool let through (review of #302)", async () => {
    for (const baseUrl of ['https://api.openai.com@evil.example.net/v1', 'https://user:pw@models.example.com/v1']) {
      const { service, asked, resolved } = endpoint(() => Response.json(MODELS));
      expect(await test(service, { ...ORG, baseUrl }), baseUrl).toEqual({ ok: false, problem: 'blocked' });
      expect(asked, baseUrl).toEqual([]);
      expect(resolved, baseUrl).toEqual([]);
    }
    const to = 'https://x:y@models.example.com/v2/models';
    const { service, asked } = endpoint((url) => (url === `${BASE}/models` ? redirect(to) : Response.json(MODELS)));
    expect(await test(service)).toEqual({ ok: false, problem: 'blocked' });
    expect(asked.map((a) => a.url)).toEqual([`${BASE}/models`]);
  });

  it('never follows a redirect to another origin, so the key stays with its address (review lesson of #280)', async () => {
    for (const to of ['https://elsewhere.example.net/v1/models', 'https://models.example.com.evil.test/models', 'http://models.example.com/v1/models']) {
      const { service, asked } = endpoint((url) => (url === `${BASE}/models` ? redirect(to) : Response.json(MODELS)));
      expect(await test(service), to).toEqual({ ok: false, problem: 'blocked' });
      expect(
        asked.map((a) => a.url),
        to,
      ).toEqual([`${BASE}/models`]);
    }
  });

  it('checks a same-origin redirect again, so a name that now resolves to a private address is refused after it', async () => {
    const moved = `${BASE.replace('/v1', '')}/v2/models`;
    const { service, asked } = endpoint(
      (url) => (url === `${BASE}/models` ? redirect(moved) : Response.json(MODELS)),
      (_host, call) => (call === 1 ? [PUBLIC] : ['10.0.0.7']),
    );
    expect(await test(service)).toEqual({ ok: false, problem: 'blocked' });
    expect(asked.map((a) => a.url)).toEqual([`${BASE}/models`]);
    // And while it stays public, the redirect is followed with the key.
    const followed = endpoint((url) => (url === `${BASE}/models` ? redirect(moved) : Response.json(MODELS)));
    expect(await test(followed.service)).toEqual({ ok: true, models: ['model-a', 'model-b'] });
    expect(followed.asked.map((a) => [a.url, a.auth])).toEqual([
      [`${BASE}/models`, `Bearer ${KEY}`],
      [moved, `Bearer ${KEY}`],
    ]);
  });

  it('opens a key only for the address it was sealed for', async () => {
    const { service, asked } = endpoint(() => Response.json(MODELS));
    const sealed = await service.seal(ORG, KEY);
    expect(await service.test({ ...ORG, baseUrl: 'https://elsewhere.example.net/v1' }, sealed)).toEqual({ ok: false, problem: 'refused' });
    expect(await service.test({ ...ORG, provider: 'anthropic', baseUrl: null }, sealed)).toEqual({ ok: false, problem: 'refused' });
    expect(asked).toEqual([]);
  });

  it('says in a word why a test failed, never the body or the key, and logs nothing', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info'), vi.spyOn(console, 'debug')];
    for (const [answer, problem] of [
      [Response.json({ error: { message: `bad key ${KEY}` } }, { status: 401 }), 'refused'],
      [new Response('no', { status: 403 }), 'refused'],
      [new Response('slow down', { status: 429 }), 'busy'],
      [new Response('down', { status: 503 }), 'busy'],
      [new Response('nope', { status: 404 }), 'unreachable'],
      [new Response('<html>not json</html>', { status: 200 }), 'unreachable'],
      [Response.json({ models: ['not', 'openai', 'shaped'] }), 'unreachable'],
    ] as const) {
      const { service } = endpoint(() => answer.clone());
      const result = await test(service);
      expect(result, `${answer.status}`).toEqual({ ok: false, problem });
      expect(JSON.stringify(result)).not.toContain('SECRETKEY');
    }
    for (const log of logs) expect(JSON.stringify(log.mock.calls)).not.toContain('SECRETKEY');
  });

  it('is changed by nothing in process.env: no SDK reads a base URL, a key or headers from it', async () => {
    const vars = {
      OPENAI_BASE_URL: 'https://elsewhere.example.net/v1',
      OPENAI_API_KEY: 'sk-someone-elses-key',
      OPENAI_ORG_ID: 'org-elsewhere',
      ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer sk-someone-elses-key',
      HTTPS_PROXY: 'https://proxy.example.net',
    };
    Object.assign(process.env, vars);
    try {
      const { service, asked } = endpoint(() => Response.json(MODELS));
      expect(await test(service)).toEqual({ ok: true, models: ['model-a', 'model-b'] });
      expect(asked).toEqual([{ url: `${BASE}/models`, auth: `Bearer ${KEY}`, apiKey: null }]);
    } finally {
      for (const name of Object.keys(vars)) delete process.env[name];
    }
  });
});
