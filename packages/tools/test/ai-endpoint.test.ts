// An OpenAI-compatible endpoint as the org's provider (#262): its address is checked where it
// enters as a feed URL is (the API's fetch guards check every request to it too), its key is sealed
// for that address and must be given again for another, and its features are what its owner says.
import { scoped } from '@signforge/db';
import { seedOrg, type SeededOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { type AiKey, type AiProviders, type Caller, dispatch, registry } from '../src';
import { fakeServices } from './services';

const KEY = 'sk-endpoint-SECRETKEYSECRETKEYSECRET-0001';
const KEY_2 = 'sk-endpoint-ANOTHERKEYANOTHERKEYANO-0002';
const BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';

const sealed: AiKey[] = [];
const aiProviders: AiProviders = {
  seal: async (key, apiKey) => {
    sealed.push(key);
    return `sealed:${key.orgId}/${key.provider}/${key.baseUrl}:${apiKey.length}`;
  },
  test: async () => ({ ok: true, models: ['gemini-model'] }),
};

let o: SeededOrg;
const owner = (): Caller => ({
  org: scoped(env.DB, o.orgId),
  role: 'owner',
  actor: { kind: 'user', id: 'user-owner', clientId: 'cms' },
  blobs: env.BLOBS,
  services: { ...fakeServices, aiProviders },
});
const call = (name: string, input: unknown) => dispatch(registry, name, input, owner());
const endpoint = (extra: object = {}) => ({ provider: 'openai-compatible', ...extra });

beforeAll(async () => {
  o = await seedOrg(env.DB, 'ai-endpoint-org');
});

describe('an OpenAI-compatible endpoint', () => {
  it('takes only a public https base address, refused where it enters', async () => {
    for (const baseUrl of [
      'http://api.example.com/v1',
      'https://127.0.0.1/v1',
      'https://[::1]/v1',
      'https://169.254.169.254/latest',
      'https://api.example.com:8443/v1',
      'https://localhost/v1',
      'https://models.internal/v1',
      'https://api.example.com/v1?key=x',
      'https://api.example.com/v1#frag',
      'not a url',
    ])
      expect(await call('save_ai_provider', endpoint({ baseUrl, apiKey: KEY })), baseUrl).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await scoped(env.DB, o.orgId).aiProvider.get()).toBeUndefined();
    expect(sealed).toEqual([]);
  });

  it('needs its address and its key, seals the key for the address, and says what the owner said it supports', async () => {
    expect(await call('save_ai_provider', endpoint({ apiKey: KEY }))).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await call('save_ai_provider', endpoint({ baseUrl: BASE }))).toMatchObject({ ok: false, error: 'invalid_input' });
    const saved = await call('save_ai_provider', endpoint({ baseUrl: `${BASE}/`, apiKey: KEY, acceptsImages: true, jsonSchemaOutput: true }));
    expect(saved).toMatchObject({
      ok: true,
      output: { provider: { provider: 'openai-compatible', baseUrl: BASE, supports: { images: true, jsonSchema: true }, keyLast4: '0001' } },
    });
    expect(sealed.at(-1)).toEqual({ orgId: o.orgId, provider: 'openai-compatible', baseUrl: BASE });
    expect(JSON.stringify(saved)).not.toContain('SECRETKEY');
  });

  it('sends the key only to the address it was saved for: a new address needs the key again', async () => {
    const before = await scoped(env.DB, o.orgId).aiProvider.get();
    expect(await call('save_ai_provider', endpoint({ baseUrl: 'https://api.openai.com/v1' }))).toMatchObject({
      ok: false,
      error: 'invalid_input',
      message: expect.stringContaining('needs the apiKey again'),
    });
    expect(await scoped(env.DB, o.orgId).aiProvider.get()).toEqual(before);
    // The same address again, or other fields, keep the key.
    expect(await call('save_ai_provider', endpoint({ baseUrl: BASE, acceptsImages: false }))).toMatchObject({
      ok: true,
      output: { provider: { keyLast4: '0001', supports: { images: false, jsonSchema: true } } },
    });
    const moved = await call('save_ai_provider', endpoint({ baseUrl: 'https://api.openai.com/v1', apiKey: KEY_2 }));
    expect(moved).toMatchObject({ ok: true, output: { provider: { baseUrl: 'https://api.openai.com/v1', keyLast4: '0002', verifiedAt: null } } });
    expect(sealed.at(-1)).toEqual({ orgId: o.orgId, provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' });
  });

  it('tests the key at its address, and Anthropic takes no address or features', async () => {
    let asked: AiKey | undefined;
    const watching: Caller = {
      ...owner(),
      services: { ...fakeServices, aiProviders: { ...aiProviders, test: async (key) => ((asked = key), { ok: true, models: [] }) } },
    };
    expect((await dispatch(registry, 'test_ai_provider', {}, watching)).ok).toBe(true);
    expect(asked).toEqual({ orgId: o.orgId, provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' });
    for (const extra of [{ baseUrl: BASE }, { acceptsImages: true }, { jsonSchemaOutput: false }])
      expect(await call('save_ai_provider', { provider: 'anthropic', apiKey: KEY, ...extra })).toMatchObject({ ok: false, error: 'invalid_input' });
  });

  it("switching provider needs that provider's key, and leaves no address, models or features behind", async () => {
    await call('save_ai_provider', endpoint({ fastModel: 'gemini-model' }));
    expect(await call('save_ai_provider', { provider: 'anthropic' })).toMatchObject({ ok: false, error: 'invalid_input' });
    const switched = await call('save_ai_provider', { provider: 'anthropic', apiKey: KEY_2 });
    expect(switched).toMatchObject({
      ok: true,
      output: { provider: { provider: 'anthropic', baseUrl: null, fastModel: null, supports: { images: true, jsonSchema: true } } },
    });
    expect(sealed.at(-1)).toEqual({ orgId: o.orgId, provider: 'anthropic', baseUrl: null });
  });
});
