// Alerts to Slack and signed outgoing webhooks (#88): a screen going offline is queued for each
// channel its rule names, sent after the check through the fetch guards, retried with backoff
// while the receiver fails, and shown in the delivery log. No network: fetch and DNS are stubbed.
import { orgMembers, scoped } from '@signforge/db';
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { checkScreenAlerts } from '../src/alerts';
import type { FetchGuards } from '../src/data/fetch';
import { deliverAlert, deliverAlerts } from '../src/deliveries';
import { emailSenderFor, RecordingEmailSender } from '../src/email';
import worker from '../src/index';
import { Client, email, testApp } from './client';

const MIN = 60_000;
const HOUR = 60 * MIN;
const SECRET = 'whsec_0123456789abcdefghijklmnopqrstuvwxyzABCD';

let orgs = 0;
/** An org whose owner has set a Slack webhook and an outgoing webhook, each with a URL of its own, and sends offline alerts to both. */
async function orgWithChannels() {
  const n = ++orgs;
  const t = testApp();
  const owner = new Client(t);
  await owner.signIn(email(`channels-${n}`));
  const name = `Northside ${n}`;
  const org = { ...(await owner.createOrg(name)), name };
  const slackUrl = `https://hooks.slack.com/services/T0ORG${n}/B0ORG${n}/secretpart${n}`;
  const webhookUrl = `https://ops${n}.example.com/hooks/sf?key=k${n}`;
  await owner.ok('/api/tools/set_slack_alert_channel', { webhookUrl: slackUrl });
  await owner.ok('/api/tools/set_webhook_alert_channel', { webhookUrl, signingSecret: SECRET });
  await owner.ok('/api/tools/update_org_settings', { alerts: { screen_offline: { slack: true, webhook: true } } });
  return { owner, org, slackUrl, webhookUrl, outbox: t.outbox };
}

async function pairedScreen(orgId: string, name: string, lastSeenAt: number) {
  const org = scoped(env.DB, orgId);
  const screen = await org.screens.insert({ name, timezone: 'UTC', orientation: 'landscape', lastSeenAt, kind: 'device' });
  await org.screens.credentials.insert({ screenId: screen.id, secretHash: '0'.repeat(64) });
  return screen.id;
}

/** Guards whose fetch answers each URL from `answers` in turn (the last one again once they run out), recording every request. */
function receivers(answers: Record<string, number[]>, dns: Record<string, string[]> = {}) {
  const requests: Request[] = [];
  const answer = (url: string) => {
    const queue = answers[url];
    if (!queue) throw new TypeError(`no receiver at ${url}`);
    return queue.length > 1 ? queue.shift()! : queue[0]!;
  };
  const guards: FetchGuards = {
    resolve: async (host) => dns[host] ?? ['93.184.216.34'],
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      const status = answer(requests.at(-1)!.url);
      return new Response(status === 200 ? 'ok' : 'no', { status });
    },
  };
  return { guards, to: (url: string) => requests.filter((r) => r.url === url) };
}

async function hmacHex(secret: string, message: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))).toString('hex');
}

interface Delivery {
  channel: string;
  eventType: string;
  status: string;
  attempts: number;
  lastHttpStatus: number | null;
  lastError: string | null;
}
const log = async (owner: Client) => (await owner.ok<{ deliveries: Delivery[] }>('/api/tools/list_alert_deliveries', {})).deliveries;

describe('alerts to Slack and webhooks', () => {
  it('posts a screen going offline to Slack and to the webhook, signed', async () => {
    const { org, slackUrl, webhookUrl, outbox } = await orgWithChannels();
    const start = Date.now();
    const screenId = await pairedScreen(org.id, 'Lobby east', start);
    const { guards, to } = receivers({ [slackUrl]: [200], [webhookUrl]: [200] });

    await checkScreenAlerts({ ...env, CMS_ORIGIN: 'https://cms.test' }, outbox, start + 16 * MIN);
    // Queued by the check, sent by the run after it.
    expect(to(slackUrl)).toEqual([]);
    await deliverAlerts(env, outbox, { now: start + 16 * MIN, guards });

    const [slack] = to(slackUrl);
    expect(slack?.method).toBe('POST');
    expect(slack?.headers.get('content-type')).toBe('application/json');
    const message = await slack!.json<{ text: string; blocks: { text?: { text: string }; fields?: { text: string }[]; elements?: { text: string }[] }[] }>();
    expect(message.text).toBe(`Lobby east in ${org.name} is offline`);
    const blocks = JSON.stringify(message.blocks);
    expect(blocks).toContain(`<https://cms.test/screens/${screenId}|Lobby east>`);
    expect(blocks).toContain('is *offline*');
    expect(blocks).toContain(`<!date^${Math.floor(start / 1000)}^{date_short_pretty} at {time}|${new Date(start).toISOString()}>`);
    expect(blocks).toContain(org.name);

    const [hook] = to(webhookUrl);
    const body = await hook!.text();
    const event = JSON.parse(body);
    expect(event).toEqual({
      type: 'screen.offline',
      id: expect.stringMatching(/^evt_/),
      occurredAt: new Date(start + 16 * MIN).toISOString(),
      org: { id: org.id, name: org.name },
      data: { screen: { id: screenId, name: 'Lobby east', url: `https://cms.test/screens/${screenId}` }, lastSeenAt: new Date(start).toISOString() },
    });
    const timestamp = hook!.headers.get('signforge-timestamp')!;
    expect(Math.abs(Number(timestamp) - Date.now() / 1000)).toBeLessThan(60);
    expect(hook!.headers.get('signforge-event-id')).toBe(event.id);
    expect(hook!.headers.get('signforge-signature')).toBe(`v1=${await hmacHex(SECRET, `${timestamp}.${body}`)}`);
    expect(hook!.headers.get('signforge-signature')).not.toBe(`v1=${await hmacHex('another secret', `${timestamp}.${body}`)}`);

    // Back: one more of each, with the same event id on both channels.
    await scoped(env.DB, org.id).screens.update(screenId, { lastSeenAt: start + 30 * MIN });
    await checkScreenAlerts(env, outbox, start + 31 * MIN);
    await deliverAlerts(env, outbox, { now: start + 31 * MIN, guards });
    const back = await to(webhookUrl)[1]!.json<{ type: string; id: string; data: { offlineSince: string } }>();
    expect(back).toMatchObject({ type: 'screen.back', data: { offlineSince: new Date(start).toISOString() } });
    expect((await to(slackUrl)[1]!.json<{ text: string }>()).text).toBe(`Lobby east in ${org.name} is back`);

    // Nothing more: each was sent once.
    await deliverAlerts(env, outbox, { now: start + 2 * HOUR, guards });
    expect([to(slackUrl).length, to(webhookUrl).length]).toEqual([2, 2]);
  });

  it('retries a receiver that answers 500, backing off, and the log shows each try', async () => {
    const { owner, org, slackUrl, webhookUrl, outbox } = await orgWithChannels();
    const start = Date.now();
    await pairedScreen(org.id, 'Till 2', start);
    const { guards, to } = receivers({ [slackUrl]: [200], [webhookUrl]: [500, 500, 200] });
    const run = (at: number) => deliverAlerts(env, outbox, { now: start + at, guards });

    await checkScreenAlerts(env, outbox, start + 16 * MIN);
    await run(16 * MIN);
    expect(to(webhookUrl)).toHaveLength(1);
    expect((await log(owner)).find((d) => d.channel === 'webhook')).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastHttpStatus: 500,
      lastError: 'http-status',
    });

    // 5 minutes after the first failure, then 10 after the second.
    await run(20 * MIN);
    expect(to(webhookUrl)).toHaveLength(1);
    await run(21 * MIN);
    expect(to(webhookUrl)).toHaveLength(2);
    await run(30 * MIN);
    expect(to(webhookUrl)).toHaveLength(2);
    await run(31 * MIN);
    expect(to(webhookUrl)).toHaveLength(3);
    expect(to(slackUrl)).toHaveLength(1);

    const entries = await log(owner);
    expect(entries.find((d) => d.channel === 'webhook')).toMatchObject({
      eventType: 'screen.offline',
      status: 'delivered',
      attempts: 3,
      lastHttpStatus: 200,
      lastError: null,
    });
    expect(entries.find((d) => d.channel === 'slack')).toMatchObject({ status: 'delivered', attempts: 1, lastHttpStatus: 200 });
  });

  it('gives up after 24 hours, and an owner can try once more', async () => {
    const { owner, org, webhookUrl, slackUrl, outbox } = await orgWithChannels();
    await owner.ok('/api/tools/update_org_settings', { alerts: { screen_offline: { slack: false } } });
    const start = Date.now();
    await pairedScreen(org.id, 'Kiosk', start);
    const { guards, to } = receivers({ [webhookUrl]: [503] });

    await checkScreenAlerts(env, outbox, start + 16 * MIN);
    await deliverAlerts(env, outbox, { now: start + 16 * MIN, guards });
    await deliverAlerts(env, outbox, { now: start + 16 * MIN + 25 * HOUR, guards });
    expect(to(slackUrl)).toEqual([]);
    const [failed] = await log(owner);
    expect(failed).toMatchObject({ channel: 'webhook', status: 'failed', attempts: 2, lastHttpStatus: 503 });

    // Tried once more (retry_alert_delivery, tested in packages/tools), here with the stubbed guards.
    const o = scoped(env.DB, org.id);
    const [row] = await o.alertDeliveries.list({ take: 1 });
    const later = start + 30 * HOUR;
    await o.commit(o.alertDeliveries.stage.retry(row!, later).writes);
    await deliverAlert(env, outbox, org.id, row!.id, { now: later, guards });
    expect(to(webhookUrl)).toHaveLength(3);
    expect((await log(owner))[0]).toMatchObject({ status: 'failed', attempts: 3, lastHttpStatus: 503 });
  });

  it('refuses a webhook whose host resolves to a private address, and fails a removed channel at once', async () => {
    const { owner, org, slackUrl, webhookUrl, outbox } = await orgWithChannels();
    const start = Date.now();
    await pairedScreen(org.id, 'Back office', start);
    const { guards, to } = receivers({ [slackUrl]: [200], [webhookUrl]: [200] }, { [new URL(webhookUrl).hostname]: ['10.0.0.5'] });

    await checkScreenAlerts(env, outbox, start + 16 * MIN);
    await owner.ok('/api/tools/remove_alert_channel', { channel: 'slack' });
    await deliverAlerts(env, outbox, { now: start + 16 * MIN, guards });
    expect([to(slackUrl), to(webhookUrl)]).toEqual([[], []]);
    const entries = await log(owner);
    expect(entries.find((d) => d.channel === 'webhook')).toMatchObject({ status: 'pending', lastError: 'private-address', lastHttpStatus: null });
    expect(entries.find((d) => d.channel === 'slack')).toMatchObject({ status: 'failed', lastError: 'no-channel' });
  });

  it('sends a test email to the owner who asks, at once', async () => {
    const { owner, outbox } = await orgWithChannels();
    const sent = await owner.ok<{ delivery: { status: string } }>('/api/tools/test_alert_channel', { channel: 'email' });
    expect(sent.delivery.status).toBe('pending');
    await owner.settled();
    expect(outbox.messages.at(-1)?.subject).toBe('SignForge: A test from SignForge: alerts reach this channel.');
    expect((await log(owner))[0]).toMatchObject({ channel: 'email', eventType: 'test', status: 'delivered', attempts: 1 });
  });

  it('stores the URLs and the secret sealed, and keeps them out of the audit log', async () => {
    const { org, slackUrl, webhookUrl } = await orgWithChannels();
    const o = scoped(env.DB, org.id);
    const stored = JSON.stringify([await o.alertChannels.list(), await o.auditLog.list({ limit: 100 })]);
    for (const secret of [slackUrl, 'secretpart', webhookUrl, 'key=k', SECRET]) expect(stored).not.toContain(secret);
  });
});

describe('the five-minute Cron Trigger', () => {
  it('sends the deliveries that are due once the alert check has run', async () => {
    const { org } = await orgWithChannels();
    const o = scoped(env.DB, org.id);
    const outbox = emailSenderFor(env);
    if (!(outbox instanceof RecordingEmailSender)) throw new Error('dev should send through the recorder');
    const [member] = await orgMembers(env.DB, org.id);
    const now = Date.now();
    await o.commit(
      o.alertDeliveries.stage.insert({
        channel: 'email',
        eventId: 'evt_cron_test',
        eventType: 'test',
        eventJson: JSON.stringify({
          type: 'test',
          id: 'evt_cron_test',
          occurredAt: new Date(now).toISOString(),
          org: { id: org.id, name: org.name },
          data: { message: 'Cron test' },
        }),
        toUserId: member!.userId,
        nextAttemptAt: now,
        giveUpAt: now,
      }).writes,
    );

    const run = async (cron: string) => {
      const ctx = createExecutionContext();
      await worker.scheduled(createScheduledController({ scheduledTime: now, cron }), env, ctx);
      await waitOnExecutionContext(ctx);
    };
    await run('* * * * *');
    expect(outbox.messages.some((m) => m.subject === 'SignForge: Cron test')).toBe(false);
    await run('*/5 * * * *');
    expect(outbox.messages.filter((m) => m.subject === 'SignForge: Cron test').map((m) => m.to)).toEqual([member!.email]);
  });
});
