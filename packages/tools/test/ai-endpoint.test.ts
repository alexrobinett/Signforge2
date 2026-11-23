// An OpenAI-compatible endpoint as the org's provider (#262): its address is checked where it
// enters as a feed URL is (the API's fetch guards check every request to it too), its key is sealed
// for that address and must be given again for another, and its features are what its owner says.
// Each test has its own org, so a check reverted fails its own test only.
import { scoped } from '@signforge/db';
import { seedOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { type AiKey, type AiProviders, type Caller, dispatch, registry } from '../src';
import { fakeServices } from './services';

const KEY = 'sk-endpoint-SECRETKEYSECRETKEYSECRET-0001';
const KEY_2 = 'sk-endpoint-ANOTHERKEYANOTHERKEYANO-0002';
const BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';

let orgs = 0;
/** A fresh org, an owner's caller in it, and what its key service was asked to seal and test. */
async function fresh() {
  const { orgId } = await seedOrg(env.DB, `ai-endpoint-${++orgs}`);
  const sealed: AiKey[] = [];
  const tested: AiKey[] = [];
  const aiProviders: AiProviders = {
    seal: async (key, apiKey) => (sealed.push(key), `sealed:${key.orgId}/${key.provider}/${key.baseUrl}:${apiKey.length}`),
    test: async (key) => (tested.push(key), { ok: true, models: ['gemini-model'] }),
  };
  const caller: Caller = {
    org: scoped(env.DB, orgId),
    role: 'owner',
    actor: { kind: 'user', id: 'user-owner', clientId: 'cms' },
    blobs: env.BLOBS,
    services: { ...fakeServices, aiProviders },
  };
  const call = (name: string, input: unknown) => dispatch(registry, name, input, caller);
  return { orgId, org: scoped(env.DB, orgId), call, sealed, tested };
}
const endpoint = (extra: object = {}) => ({ provider: 'openai-compatible', ...extra });
/** An org whose endpoint is saved at `baseUrl` with KEY, as the first save leaves it. */
async function saved(baseUrl = BASE, extra: object = {}) {
  const f = await fresh();
  const result = await f.call('save_ai_provider', endpoint({ baseUrl, apiKey: KEY, ...extra }));
  expect(result.ok).toBe(true);
  return f;
}

describe('an OpenAI-compatible endpoint', () => {
  it('takes only a public https base address with no user name or password, refused where it enters', async () => {
    const { org, call, sealed } = await fresh();
    for (const baseUrl of [
      'http://api.example.com/v1',
      'https://127.0.0.1/v1',
      'https://[::1]/v1',
      'https://169.254.169.254/latest',
      'https://api.example.com:8443/v1',
      'https://localhost/v1',
      'https://models.internal/v1',
      // Reads as OpenAI, goes to evil.example.net (review of #302).
      'https://api.openai.com@evil.example.net/v1',
      // A password would be stored in clear, shown to every member and kept in the audit log.
      'https://user:pw@api.example.com/v1',
      'https://api.example.com/v1?key=x',
      'https://api.example.com/v1#frag',
      'not a url',
    ])
      expect(await call('save_ai_provider', endpoint({ baseUrl, apiKey: KEY })), baseUrl).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await org.aiProvider.get()).toBeUndefined();
    expect(sealed).toEqual([]);
  });

  it('needs its address and its key, seals the key for the address, and says what the owner said it supports', async () => {
    const { orgId, call, sealed } = await fresh();
    expect(await call('save_ai_provider', endpoint({ apiKey: KEY }))).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await call('save_ai_provider', endpoint({ baseUrl: BASE }))).toMatchObject({ ok: false, error: 'invalid_input' });
    const result = await call('save_ai_provider', endpoint({ baseUrl: `${BASE}/`, apiKey: KEY, acceptsImages: true, jsonSchemaOutput: true }));
    expect(result).toMatchObject({
      ok: true,
      output: { provider: { provider: 'openai-compatible', baseUrl: BASE, supports: { images: true, jsonSchema: true }, keyLast4: '0001' } },
    });
    expect(sealed).toEqual([{ orgId, provider: 'openai-compatible', baseUrl: BASE }]);
    expect(JSON.stringify(result)).not.toContain('SECRETKEY');
  });

  it('sends the key only to the address it was saved for: a new address needs the key again', async () => {
    const { orgId, org, call, sealed } = await saved();
    const before = await org.aiProvider.get();
    expect(await call('save_ai_provider', endpoint({ baseUrl: 'https://api.openai.com/v1' }))).toMatchObject({
      ok: false,
      error: 'invalid_input',
      message: expect.stringContaining('needs the apiKey again'),
    });
    expect(await org.aiProvider.get()).toEqual(before);
    // The same address again, or other fields, keep the key.
    expect(await call('save_ai_provider', endpoint({ baseUrl: BASE, acceptsImages: false, jsonSchemaOutput: true }))).toMatchObject({
      ok: true,
      output: { provider: { keyLast4: '0001', supports: { images: false, jsonSchema: true } } },
    });
    const moved = await call('save_ai_provider', endpoint({ baseUrl: 'https://api.openai.com/v1', apiKey: KEY_2 }));
    expect(moved).toMatchObject({ ok: true, output: { provider: { baseUrl: 'https://api.openai.com/v1', keyLast4: '0002', verifiedAt: null } } });
    expect(sealed.at(-1)).toEqual({ orgId, provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' });
  });

  it('tests the key at its own address', async () => {
    const { orgId, call, tested } = await saved('https://api.openai.com/v1');
    expect((await call('test_ai_provider', {})).ok).toBe(true);
    expect(tested).toEqual([{ orgId, provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' }]);
  });

  it('takes no address or features for Anthropic', async () => {
    const { org, call } = await fresh();
    for (const extra of [{ baseUrl: BASE }, { acceptsImages: true }, { jsonSchemaOutput: false }])
      expect(await call('save_ai_provider', { provider: 'anthropic', apiKey: KEY, ...extra }), JSON.stringify(extra)).toMatchObject({
        ok: false,
        error: 'invalid_input',
      });
    expect(await org.aiProvider.get()).toBeUndefined();
  });

  it("switching provider needs that provider's key, and leaves no address, models or features behind", async () => {
    const { orgId, call, sealed } = await saved(BASE, { fastModel: 'gemini-model', acceptsImages: true });
    expect(await call('save_ai_provider', { provider: 'anthropic' })).toMatchObject({ ok: false, error: 'invalid_input' });
    const switched = await call('save_ai_provider', { provider: 'anthropic', apiKey: KEY_2 });
    expect(switched).toMatchObject({
      ok: true,
      output: { provider: { provider: 'anthropic', baseUrl: null, fastModel: null, supports: { images: true, jsonSchema: true } } },
    });
    expect(sealed.at(-1)).toEqual({ orgId, provider: 'anthropic', baseUrl: null });
  });
});
