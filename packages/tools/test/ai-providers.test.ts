// The org's own model provider (#261): owners save, test and remove a key, sealed before it is
// stored and never shown, audited or echoed again; everyone else reads it without the key; an
// agent, a Milestone 4 grant or the in-CMS agent acting as an owner, is refused.
import { scoped } from '@signforge/db';
import { seedOrg, type SeededOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type AiProviderTest, type AiProviders, type Caller, dispatch, registry } from '../src';
import { fakeServices } from './services';

const KEY = 'sk-ant-api03-SECRETKEYSECRETKEYSECRET-7Q2c';
const KEY_2 = 'sk-ant-api03-ANOTHERKEYANOTHERKEYANOT-9Zx1';
/** What any part of the key would look like in text. */
const leaks = (text: string) => text.includes('SECRETKEY') || text.includes('ANOTHERKEY');

let answer: AiProviderTest = { ok: true, models: ['claude-haiku-5-5', 'claude-sonnet-5-5'] };
const tested: string[] = [];
const aiProviders: AiProviders = {
  seal: async (key, apiKey) => `sealed:${key.orgId}/${key.provider}:${apiKey.length}`,
  test: async (key, sealed) => {
    tested.push(`${key.orgId}/${key.provider}:${sealed}`);
    return answer;
  },
};

let o: SeededOrg;
const as = (role: Caller['role'], actor: Partial<Caller['actor']> = {}): Caller => ({
  org: scoped(env.DB, o.orgId),
  role,
  actor: { kind: 'user', id: `user-${role}`, clientId: 'cms', ...actor },
  blobs: env.BLOBS,
  services: { ...fakeServices, aiProviders },
  agentLimiter: { take: async () => ({ ok: true }), audited: async () => {} },
});
const call = (name: string, input: unknown, caller = as('owner')) => dispatch(registry, name, input, caller);
const auditText = async () => JSON.stringify(await scoped(env.DB, o.orgId).auditLog.list({ limit: 100 }));

beforeAll(async () => {
  o = await seedOrg(env.DB, 'ai-provider-org');
});
afterEach(() => vi.restoreAllMocks());

describe('the AI provider tools', () => {
  it('save a key sealed, show only its last four characters, and never put it in an output, the audit log or a log line', async () => {
    const logged = vi.spyOn(console, 'log');
    const warned = vi.spyOn(console, 'warn');
    const errored = vi.spyOn(console, 'error');
    expect(await call('get_ai_provider', {}, as('viewer'))).toEqual({ ok: true, output: { provider: null } });

    const saved = await call('save_ai_provider', { provider: 'anthropic', apiKey: KEY });
    expect(saved).toMatchObject({
      ok: true,
      output: { provider: { provider: 'anthropic', keyLast4: '7Q2c', keySavedBy: 'user-owner', verifiedAt: null, version: 1 } },
    });
    const stored = await scoped(env.DB, o.orgId).aiProvider.get();
    expect(stored?.keySealed).toBe(`sealed:${o.orgId}/anthropic:${KEY.length}`);

    const tested = await call('test_ai_provider', {});
    expect(tested).toMatchObject({ ok: true, output: { ok: true, models: ['claude-haiku-5-5', 'claude-sonnet-5-5'], problem: null } });
    const chosen = await call('save_ai_provider', {
      provider: 'anthropic',
      fastModel: 'claude-haiku-5-5',
      capableModel: 'claude-sonnet-5-5',
      dailyTurnCeiling: 300,
    });
    expect(chosen).toMatchObject({ ok: true, output: { provider: { keyLast4: '7Q2c', fastModel: 'claude-haiku-5-5', dailyTurnCeiling: 300 } } });

    for (const text of [saved, tested, chosen, await call('get_ai_provider', {}, as('viewer'))].map((r) => JSON.stringify(r)))
      expect(leaks(text), text).toBe(false);
    expect(leaks(await auditText())).toBe(false);
    expect(await auditText()).toContain('[redacted]');
    for (const spy of [logged, warned, errored]) expect(leaks(JSON.stringify(spy.mock.calls))).toBe(false);
  });

  it('never echoes a key it refuses', async () => {
    for (const apiKey of [`${KEY} with spaces`, 'SECRETKEY', `SECRETKEY${'x'.repeat(600)}`]) {
      const refused = await call('save_ai_provider', { provider: 'anthropic', apiKey });
      expect(refused, apiKey.slice(0, 12)).toMatchObject({ ok: false, error: 'invalid_input' });
      expect(leaks(JSON.stringify(refused))).toBe(false);
    }
  });

  it('marks a key verified when a test reaches the provider, and a new key unverified until tested', async () => {
    answer = { ok: true, models: ['claude-haiku-5-5'] };
    const verified = await call('test_ai_provider', {});
    expect(verified).toMatchObject({ ok: true, output: { provider: { verifiedAt: expect.any(Number) } } });
    const replaced = await call('save_ai_provider', { provider: 'anthropic', apiKey: KEY_2 });
    expect(replaced).toMatchObject({ ok: true, output: { provider: { keyLast4: '9Zx1', verifiedAt: null, fastModel: 'claude-haiku-5-5' } } });

    answer = { ok: false, problem: 'refused' };
    expect(await call('test_ai_provider', {})).toMatchObject({
      ok: true,
      output: { ok: false, models: [], problem: 'refused', provider: { verifiedAt: null } },
    });
    expect(tested.at(-1)).toBe(`${o.orgId}/anthropic:sealed:${o.orgId}/anthropic:${KEY_2.length}`);
  });

  it('takes only exact-looking model ids, and changes only the version read', async () => {
    expect(await call('save_ai_provider', { provider: 'anthropic', fastModel: 'haiku please' })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await call('save_ai_provider', { provider: 'anthropic', dailyTurnCeiling: 0 })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await call('save_ai_provider', { provider: 'anthropic', dailyTurnCeiling: 50, ifVersion: 1 })).toMatchObject({ ok: false, error: 'conflict' });
  });

  it('let editors and viewers read it, without the key, and nothing else', async () => {
    for (const role of ['editor', 'viewer'] as const) {
      const read = await call('get_ai_provider', {}, as(role));
      expect(read).toMatchObject({ ok: true, output: { provider: { provider: 'anthropic', keyLast4: '9Zx1' } } });
      expect(leaks(JSON.stringify(read))).toBe(false);
      for (const [name, input] of [
        ['save_ai_provider', { provider: 'anthropic', apiKey: KEY }],
        ['test_ai_provider', {}],
        ['remove_ai_provider', {}],
      ] as const)
        expect(await call(name, input, as(role)), `${role} ${name}`).toMatchObject({ ok: false, error: 'forbidden' });
    }
  });

  it('refuse an agent grant and the in-CMS agent, even acting as an owner', async () => {
    const before = await scoped(env.DB, o.orgId).aiProvider.get();
    for (const actor of [{ kind: 'agent' as const, id: 'grant-1', clientId: 'some-agent' }, { clientId: 'cms-agent' }])
      for (const [name, input] of [
        ['save_ai_provider', { provider: 'anthropic', apiKey: KEY }],
        ['test_ai_provider', {}],
        ['remove_ai_provider', {}],
      ] as const)
        expect(await call(name, input, as('owner', actor)), `${actor.clientId} ${name}`).toMatchObject({
          ok: false,
          error: 'forbidden',
          message: expect.stringContaining('Only a person'),
        });
    expect(await scoped(env.DB, o.orgId).aiProvider.get()).toEqual(before);
  });

  it('remove the sealed key, and the org goes back to the demo model', async () => {
    expect(await call('remove_ai_provider', {})).toEqual({ ok: true, output: { removed: true } });
    expect(await scoped(env.DB, o.orgId).aiProvider.get()).toBeUndefined();
    expect(await call('get_ai_provider', {}, as('viewer'))).toEqual({ ok: true, output: { provider: null } });
    expect(await call('remove_ai_provider', {})).toEqual({ ok: true, output: { removed: false } });
    expect(await call('test_ai_provider', {})).toMatchObject({ ok: false, error: 'not_found' });
    expect(await call('save_ai_provider', { provider: 'anthropic', fastModel: null })).toMatchObject({ ok: false, error: 'invalid_input' });
  });
});
