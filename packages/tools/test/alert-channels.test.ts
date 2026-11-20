// Alert channels (#88): owners set a Slack webhook and an outgoing webhook, sealed and never shown
// again; test sends and retries queue a delivery and ask for it to go now.
import { scoped } from '@signforge/db';
import { seedOrg, type SeededOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { dispatch, registry, type AlertSecretSealer, type Caller } from '../src';
import { fakeServices } from './services';

const SLACK = 'https://hooks.slack.com/services/T0A1B2C3D/B0A1B2C3D/abcDEF123ghiJKL456mno789';
const SECRET = 'whsec_0123456789abcdefghijklmnopqrstuvwxyzABCD';
const SECRET_2 = 'whsec_ZYXWVUTSRQPONMLKJIHGFEDCBAzyxwvutsrqponmlk';

const sealer: AlertSecretSealer = { seal: async (c, field, value) => `sealed:${c.orgId}/${c.kind}/${field}:${value}` };

let o: SeededOrg;
let sentNow: string[];
const as = (role: Caller['role'], kind: 'user' | 'agent' = 'user'): Caller => ({
  org: scoped(env.DB, o.orgId),
  role,
  actor: { kind, id: `${kind}-${role}`, clientId: 'cms' },
  blobs: env.BLOBS,
  services: { ...fakeServices, alertSecrets: sealer, deliverNow: (id) => void sentNow.push(id) },
  agentLimiter: { take: async () => ({ ok: true }), audited: async () => {} },
});
const call = (name: string, input: unknown, role: Caller['role'] = 'owner') => dispatch(registry, name, input, as(role));

beforeAll(async () => {
  o = await seedOrg(env.DB, 'channels-org');
  sentNow = [];
});

describe('alert channels', () => {
  it('sets a Slack webhook, sealed, showing only its host', async () => {
    expect(await call('get_alert_channels', {}, 'viewer')).toMatchObject({ ok: true, output: { slack: null, webhook: null } });
    const set = await call('set_slack_alert_channel', { webhookUrl: SLACK });
    expect(set).toMatchObject({
      ok: true,
      output: { channel: { kind: 'slack', host: 'hooks.slack.com', connectedBy: 'user-owner', secretSetAt: null, version: 1 } },
    });
    expect(JSON.stringify(set)).not.toContain('abcDEF123');

    const stored = await scoped(env.DB, o.orgId).alertChannels.get('slack');
    expect(stored?.urlEncrypted).toBe(`sealed:${o.orgId}/slack/url:${SLACK}`);
    expect(JSON.stringify(await call('get_alert_channels', {}, 'viewer'))).not.toContain('abcDEF123');
  });

  it('takes only a Slack incoming-webhook URL', async () => {
    for (const webhookUrl of [
      'https://hooks.slack.com.evil.test/services/T1/B1/x',
      'http://hooks.slack.com/services/T1/B1/x',
      'https://example.com/services/T1/B1/x',
    ])
      expect(await call('set_slack_alert_channel', { webhookUrl }), webhookUrl).toMatchObject({ ok: false, error: 'invalid_input' });
  });

  it('sets a webhook with its signing secret, rotates the secret alone, and never shows or audits either', async () => {
    expect(await call('set_webhook_alert_channel', { webhookUrl: 'https://ops.example.com/hooks/sf' })).toMatchObject({ ok: false, error: 'invalid_input' });
    const set = await call('set_webhook_alert_channel', { webhookUrl: 'https://ops.example.com/hooks/sf?token=abc', signingSecret: SECRET });
    expect(set).toMatchObject({ ok: true, output: { channel: { kind: 'webhook', host: 'ops.example.com', version: 1 } } });
    const first = await scoped(env.DB, o.orgId).alertChannels.get('webhook');

    const rotated = await call('set_webhook_alert_channel', { signingSecret: SECRET_2, ifVersion: 1 });
    expect(rotated).toMatchObject({ ok: true, output: { channel: { host: 'ops.example.com', version: 2 } } });
    const second = await scoped(env.DB, o.orgId).alertChannels.get('webhook');
    expect(second?.urlEncrypted).toBe(first?.urlEncrypted);
    expect(second?.secretEncrypted).toBe(`sealed:${o.orgId}/webhook/secret:${SECRET_2}`);
    expect(await call('set_webhook_alert_channel', { signingSecret: SECRET, ifVersion: 1 })).toMatchObject({ ok: false, error: 'conflict' });

    const seen = JSON.stringify([set, rotated, await call('get_alert_channels', {}), await scoped(env.DB, o.orgId).auditLog.list({ limit: 200 })]);
    for (const secret of [SECRET, SECRET_2, 'token=abc', SLACK]) expect(seen).not.toContain(secret);
  });

  it('refuses webhook URLs the fetch-safety rules refuse, and weak secrets', async () => {
    for (const webhookUrl of ['http://ops.example.com/h', 'https://10.0.0.1/h', 'https://ops.example.com:8443/h', 'https://router.local/h'])
      expect(await call('set_webhook_alert_channel', { webhookUrl, signingSecret: SECRET }), webhookUrl).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await call('set_webhook_alert_channel', { signingSecret: 'short' })).toMatchObject({ ok: false, error: 'invalid_input' });
  });

  it('lets only owners set, test, remove or retry', async () => {
    for (const role of ['editor', 'viewer'] as const) {
      expect(await call('set_slack_alert_channel', { webhookUrl: SLACK }, role)).toMatchObject({ error: 'forbidden' });
      expect(await call('test_alert_channel', { channel: 'slack' }, role)).toMatchObject({ error: 'forbidden' });
      expect(await call('remove_alert_channel', { channel: 'slack' }, role)).toMatchObject({ error: 'forbidden' });
      expect(await call('retry_alert_delivery', { alertDeliveryId: o.alertDelivery }, role)).toMatchObject({ error: 'forbidden' });
    }
    expect(await call('list_alert_deliveries', {}, 'viewer')).toMatchObject({ ok: true });
  });

  it('queues a test send that is tried once, now', async () => {
    sentNow = [];
    const test = await call('test_alert_channel', { channel: 'webhook' });
    expect(test).toMatchObject({ ok: true, output: { delivery: { channel: 'webhook', eventType: 'test', status: 'pending', attempts: 0 } } });
    if (!test.ok) throw new Error(test.message);
    const { delivery } = test.output as { delivery: { id: string; eventId: string } };
    expect(sentNow).toEqual([delivery.id]);

    const row = await scoped(env.DB, o.orgId).alertDeliveries.get(delivery.id);
    expect(row?.giveUpAt).toBe(row?.nextAttemptAt);
    expect(JSON.parse(row!.eventJson)).toEqual({
      type: 'test',
      id: delivery.eventId,
      occurredAt: expect.any(String),
      org: { id: o.orgId, name: expect.any(String) },
      data: { message: expect.any(String) },
    });

    const email = await call('test_alert_channel', { channel: 'email' });
    expect(email).toMatchObject({ ok: true, output: { delivery: { channel: 'email' } } });
    expect((await scoped(env.DB, o.orgId).alertDeliveries.list({ take: 1 }))[0]?.toUserId).toBe('user-owner');
    expect(await dispatch(registry, 'test_alert_channel', { channel: 'email' }, as('owner', 'agent'))).toMatchObject({ error: 'invalid_input' });
  });

  it('retries a failed delivery now, but not a delivered one', async () => {
    sentNow = [];
    const retry = await call('retry_alert_delivery', { alertDeliveryId: o.alertDelivery });
    expect(retry).toMatchObject({ ok: true, output: { delivery: { id: o.alertDelivery, status: 'pending' } } });
    expect(sentNow).toEqual([o.alertDelivery]);
    const row = await scoped(env.DB, o.orgId).alertDeliveries.get(o.alertDelivery);
    expect(row!.giveUpAt).toBeGreaterThanOrEqual(row!.nextAttemptAt);

    const org = scoped(env.DB, o.orgId);
    await org.alertDeliveries.settle(o.alertDelivery, 16, Date.now(), { ok: true, httpStatus: 200 });
    expect(await call('retry_alert_delivery', { alertDeliveryId: o.alertDelivery })).toMatchObject({ ok: false, error: 'conflict' });
    expect(await call('retry_alert_delivery', { alertDeliveryId: 'dlv_nothere' })).toMatchObject({ ok: false, error: 'not_found' });
  });

  it('refuses to retry a delivery while an attempt holds it, and retries it once that attempt is settled', async () => {
    const org = scoped(env.DB, o.orgId);
    const test = await call('test_alert_channel', { channel: 'email' });
    if (!test.ok) throw new Error(test.message);
    const { id } = (test.output as { delivery: { id: string } }).delivery;
    const now = Date.now();
    const claimed = await org.alertDeliveries.claim(id, now, 4 * 60_000);
    expect(claimed?.attempts).toBe(1);

    expect(await call('retry_alert_delivery', { alertDeliveryId: id })).toMatchObject({ ok: false, error: 'conflict' });
    await org.alertDeliveries.settle(id, 1, now, { ok: false, httpStatus: null, error: 'email' });
    expect(await org.alertDeliveries.get(id)).toMatchObject({ status: 'failed', lastError: 'email' });
    expect(await call('retry_alert_delivery', { alertDeliveryId: id })).toMatchObject({ ok: true, output: { delivery: { status: 'pending' } } });
  });

  it('removes a channel, and refuses to test one that is not set', async () => {
    expect(await call('remove_alert_channel', { channel: 'slack' })).toMatchObject({ ok: true, output: { removed: true } });
    expect(await call('remove_alert_channel', { channel: 'slack' })).toMatchObject({ ok: true, output: { removed: false } });
    expect(await call('test_alert_channel', { channel: 'slack' })).toMatchObject({ ok: false, error: 'conflict' });
    expect(await call('get_alert_channels', {})).toMatchObject({ output: { slack: null } });
  });
});
