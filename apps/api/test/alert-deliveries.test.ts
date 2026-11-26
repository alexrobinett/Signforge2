// Alerts to Slack and signed outgoing webhooks (#88): a screen going offline is queued for each
// channel its rule names, sent after the check through the fetch guards, retried with backoff
// while the receiver fails, and shown in the delivery log. No network: fetch and DNS are stubbed.
import { orgMembers, scoped } from '@signforge/db';
import { testScope } from '@signforge/db/testing';
import { dispatch, registry } from '@signforge/tools';
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { alertAgentRefused, checkScreenAlerts, finishRollouts } from '../src/alerts';
import type { FetchGuards } from '../src/data/fetch';
import { deliverAlert, deliverAlerts } from '../src/deliveries';
import { emailSenderFor, RecordingEmailSender } from '../src/email';
import worker from '../src/index';
import { Client, email, testApp } from './client';
import { agentToken, check } from './oauth';

/**
 * `real` as the Worker sees it, counting each query and batch (each is one query against the
 * per-invocation limit), and failing any statement whose SQL matches `fail`, alone or in a batch.
 */
function watchedD1(real: D1Database, fail?: RegExp) {
  const seen = { queries: 0 };
  const refuse = (sql: string) => {
    if (fail?.test(sql)) throw new Error(`D1_ERROR: refused for the test: ${sql.slice(0, 60)}`);
  };
  type Wrapped = D1PreparedStatement & { real: D1PreparedStatement; sql: string };
  const wrap = (stmt: D1PreparedStatement, sql: string): Wrapped => {
    const call =
      (method: 'run' | 'all' | 'raw' | 'first') =>
      (...args: unknown[]) => {
        seen.queries++;
        refuse(sql);
        return (stmt[method] as (...a: unknown[]) => unknown).apply(stmt, args);
      };
    return {
      real: stmt,
      sql,
      bind: (...v: unknown[]) => wrap(stmt.bind(...v), sql),
      run: call('run'),
      all: call('all'),
      raw: call('raw'),
      first: call('first'),
    } as unknown as Wrapped;
  };
  const db = {
    prepare: (sql: string) => wrap(real.prepare(sql), sql),
    batch: async (stmts: Wrapped[]) => {
      seen.queries++;
      for (const s of stmts) refuse(s.sql);
      return real.batch(stmts.map((s) => s.real));
    },
  };
  return { db: db as unknown as D1Database, seen };
}

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
  const org = testScope(env.DB, orgId);
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
    // Signed when sent, 2.5 s into the run.
    onTestFinished(() => void vi.useRealTimers());
    vi.setSystemTime(start + 16 * MIN + 2_500);
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
    expect(timestamp).toBe(String(Math.floor((start + 16 * MIN + 2_500) / 1000)));
    expect(hook!.headers.get('signforge-event-id')).toBe(event.id);
    expect(hook!.headers.get('signforge-signature')).toBe(`v1=${await hmacHex(SECRET, `${timestamp}.${body}`)}`);
    expect(hook!.headers.get('signforge-signature')).not.toBe(`v1=${await hmacHex('another secret', `${timestamp}.${body}`)}`);

    // Back: one more of each, with the same event id on both channels.
    await testScope(env.DB, org.id).screens.update(screenId, { lastSeenAt: start + 30 * MIN });
    await checkScreenAlerts(env, outbox, start + 31 * MIN);
    await deliverAlerts(env, outbox, { now: start + 31 * MIN, guards });
    const back = await to(webhookUrl)[1]!.json<{ type: string; id: string; data: { offlineSince: string } }>();
    expect(back).toMatchObject({ type: 'screen.back', data: { offlineSince: new Date(start).toISOString() } });
    expect((await to(slackUrl)[1]!.json<{ text: string }>()).text).toBe(`Lobby east in ${org.name} is back`);

    // Nothing more: each was sent once.
    await deliverAlerts(env, outbox, { now: start + 2 * HOUR, guards });
    expect([to(slackUrl).length, to(webhookUrl).length]).toEqual([2, 2]);
  });

  it('sends a rollout that reached every screen, once, to Slack, the webhook and by email (M3-18)', async () => {
    const { owner, org, slackUrl, webhookUrl, outbox } = await orgWithChannels();
    await owner.ok('/api/tools/update_org_settings', { alerts: { publish_finished: { slack: true, webhook: true } } });
    const start = Date.now();
    const o = testScope(env.DB, org.id);
    const screens = [await pairedScreen(org.id, 'Till 1', start), await pairedScreen(org.id, 'Till 2', start)];
    const made = o.publishes.stage.insert({ status: 'published', actorKind: 'user', actorId: 'user-1', revision: 1 });
    const rows = screens.map((screenId, i) => ({ screenId, manifestId: String(i + 1).repeat(64) }));
    await o.commit([
      ...made.writes,
      ...o.publishes.stage.addScreens(made.row.id, rows).writes,
      ...rows.flatMap((r) => o.screens.stage.setDesiredManifest(r.screenId, r.manifestId).writes),
    ]);
    const { guards, to } = receivers({ [slackUrl]: [200], [webhookUrl]: [200] });
    const cms = { ...env, CMS_ORIGIN: 'https://cms.test' };
    const finished = () => outbox.messages.filter((m) => m.subject === 'v1 reached every screen');

    // One screen still switching: not finished.
    await o.screens.reportManifest(rows[0]!.screenId, rows[0]!.manifestId, { arrivedAt: start });
    await finishRollouts(cms, outbox, start + MIN);
    expect(finished()).toEqual([]);

    await o.screens.reportManifest(rows[1]!.screenId, rows[1]!.manifestId, { arrivedAt: start });
    await finishRollouts(cms, outbox, start + 2 * MIN);
    await deliverAlerts(env, outbox, { now: start + 2 * MIN, guards });
    expect(finished().map((m) => m.to)).toEqual([(await orgMembers(env.DB, org.id))[0]!.email]);
    expect(finished()[0]!.text).toContain(`v1 in ${org.name}`);
    expect(finished()[0]!.text).toContain('all 2 screens it changed');
    const event = await to(webhookUrl)[0]!.json();
    expect(event).toEqual({
      type: 'publish.finished',
      id: `evt_${made.row.id}_finished`,
      occurredAt: new Date(start + 2 * MIN).toISOString(),
      org: { id: org.id, name: org.name },
      data: {
        publish: { id: made.row.id, revision: 1, url: `https://cms.test/publishes?id=${made.row.id}`, publishedAt: new Date(made.row.createdAt).toISOString() },
        screens: 2,
        playing: 2,
        replaced: 0,
      },
    });
    const slack = await to(slackUrl)[0]!.json<{ text: string; blocks: unknown[] }>();
    expect(slack.text).toBe(`v1 reached every screen in ${org.name}`);
    expect(JSON.stringify(slack.blocks)).toContain(`<https://cms.test/publishes?id=${made.row.id}|v1>`);
    expect((await o.publishes.get(made.row.id))!.finishedAt).toBe(start + 2 * MIN);

    // Marked: the next check sends nothing more.
    await finishRollouts(cms, outbox, start + 7 * MIN);
    await deliverAlerts(env, outbox, { now: start + 7 * MIN, guards });
    expect([finished().length, to(slackUrl).length, to(webhookUrl).length]).toEqual([1, 1, 1]);

    // v2 undone by v3 before any screen played it: marked, with no alert, and its history row is not complete.
    const publishTo = async (revision: number, manifests: string[]) => {
      const p = o.publishes.stage.insert({ status: 'published', actorKind: 'user', actorId: 'user-1', revision });
      const r = screens.map((screenId, i) => ({ screenId, manifestId: manifests[i]! }));
      await o.commit([
        ...p.writes,
        ...o.publishes.stage.addScreens(p.row.id, r).writes,
        ...r.flatMap((x) => o.screens.stage.setDesiredManifest(x.screenId, x.manifestId).writes),
      ]);
      return p.row;
    };
    const v2 = await publishTo(2, ['a'.repeat(64), 'b'.repeat(64)]);
    // v3 puts back what the screens still play, so it is finished at once, and says so.
    await publishTo(
      3,
      rows.map((r) => r.manifestId),
    );
    await finishRollouts(cms, outbox, start + 12 * MIN);
    await deliverAlerts(env, outbox, { now: start + 12 * MIN, guards });
    expect((await o.publishes.get(v2.id))!.finishedAt).toBe(start + 12 * MIN);
    expect(outbox.messages.filter((m) => m.subject.startsWith('v2 '))).toEqual([]);
    expect(outbox.messages.filter((m) => m.subject === 'v3 reached every screen')).toHaveLength(1);
    expect([to(slackUrl).length, to(webhookUrl).length]).toEqual([2, 2]);
    const history = (await owner.ok<{ publishes: { revision: number; screens: number; playing: number; replaced: number }[] }>('/api/tools/list_publishes', {}))
      .publishes;
    expect(history.find((h) => h.revision === 2)).toMatchObject({ screens: 2, playing: 0, replaced: 2 });

    // v4 reaches one screen while v5 replaces it on the other: played versus replaced, in words.
    const v4 = await publishTo(4, ['c'.repeat(64), 'd'.repeat(64)]);
    await o.screens.reportManifest(screens[0]!, 'c'.repeat(64), { arrivedAt: start + 13 * MIN });
    const v5 = o.publishes.stage.insert({ status: 'published', actorKind: 'user', actorId: 'user-1', revision: 5 });
    await o.commit([
      ...v5.writes,
      ...o.publishes.stage.addScreens(v5.row.id, [{ screenId: screens[1]!, manifestId: 'e'.repeat(64) }]).writes,
      ...o.screens.stage.setDesiredManifest(screens[1]!, 'e'.repeat(64)).writes,
    ]);
    await finishRollouts(cms, outbox, start + 17 * MIN);
    await deliverAlerts(env, outbox, { now: start + 17 * MIN, guards });
    expect(outbox.messages.find((m) => m.subject.startsWith('v4 '))?.subject).toBe('v4 finished, playing on 1 of 2 screens');
    expect(await to(webhookUrl)[2]!.json()).toMatchObject({ type: 'publish.finished', data: { publish: { id: v4.id }, screens: 2, playing: 1, replaced: 1 } });
    expect((await to(slackUrl)[2]!.json<{ text: string }>()).text).toBe(`v4 finished in ${org.name}: playing on 1 of 2 screens`);
  });

  it('counts a screen that played a publish, then was switched by the next before it said so, as playing, not replaced (re-check of #127)', async () => {
    const { owner, org, webhookUrl, outbox } = await orgWithChannels();
    await owner.ok('/api/tools/update_org_settings', { alerts: { publish_finished: { webhook: true } } });
    const start = Date.now();
    const o = testScope(env.DB, org.id);
    const screens = [await pairedScreen(org.id, 'Till 1', start), await pairedScreen(org.id, 'Till 2', start)];
    const publishTo = async (revision: number, manifest: (i: number) => string) => {
      const p = o.publishes.stage.insert({ status: 'published', actorKind: 'user', actorId: 'user-1', revision });
      const r = screens.map((screenId, i) => ({ screenId, manifestId: manifest(i) }));
      await o.commit([
        ...p.writes,
        ...o.publishes.stage.addScreens(p.row.id, r).writes,
        ...r.flatMap((x) => o.screens.stage.setDesiredManifest(x.screenId, x.manifestId).writes),
      ]);
      return p.row;
    };
    const v1 = await publishTo(1, (i) => String(i + 1).repeat(64));
    for (const [i, id] of screens.entries()) await o.screens.reportManifest(id, String(i + 1).repeat(64), { arrivedAt: start });
    // v2 switches both while they are still fetching it: they report v1.
    await publishTo(2, (i) => String(i + 5).repeat(64));
    const { guards, to } = receivers({ [webhookUrl]: [200] });
    await finishRollouts(env, outbox, start + MIN);
    await deliverAlerts(env, outbox, { now: start + MIN, guards });

    const sent = outbox.messages.filter((m) => m.subject.startsWith('v1 '));
    expect(sent.map((m) => m.subject)).toEqual(['v1 reached every screen']);
    expect(sent[0]!.text).not.toMatch(/revoked|later publish/);
    expect((await to(webhookUrl)[0]!.json<{ data: unknown }>()).data).toMatchObject({ screens: 2, playing: 2, replaced: 0 });
    // The history row: played by both, then replaced, is complete, not "moved on".
    const history = (
      await owner.ok<{ publishes: { id: string; playing: number; replaced: number; reached: number | null }[] }>('/api/tools/list_publishes', {})
    ).publishes;
    expect(history.find((h) => h.id === v1.id)).toMatchObject({ playing: 2, replaced: 0, reached: 2 });
    // Once they report v2, v1 still says it reached both.
    for (const [i, id] of screens.entries()) await o.screens.reportManifest(id, String(i + 5).repeat(64), { arrivedAt: start + 2 * MIN });
    const later = (await owner.ok<{ publishes: { id: string; playing: number; replaced: number; reached: number | null }[] }>('/api/tools/list_publishes', {}))
      .publishes;
    expect(later.find((h) => h.id === v1.id)).toMatchObject({ playing: 0, replaced: 2, reached: 2 });
  });

  it('sends a publish request to Slack, the webhook, and by email to each member who may approve when it is sent, never the asker or its reason (M4-09)', async () => {
    const { owner, org, slackUrl, webhookUrl, outbox } = await orgWithChannels();
    await owner.ok('/api/tools/update_org_settings', { alerts: { publish_requested: { slack: true, webhook: true } } });
    const o = testScope(env.DB, org.id);
    // An editor who asks, another who may approve, and a viewer, who may not.
    const member = async (name: string, role: string) => {
      const userId = `${org.id}-${name}`;
      await env.DB.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, '2026-11-24', '2026-11-24')")
        .bind(userId, name, `${userId}@signforge.test`)
        .run();
      await env.DB.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, '2026-11-24')")
        .bind(`${userId}-m`, org.id, userId, role)
        .run();
      return { userId, email: `${userId}@signforge.test` };
    };
    const asker = await member('Ada', 'editor');
    const other = await member('Ben', 'editor');
    const viewer = await member('Cy', 'viewer');
    const ownerEmail = (await orgMembers(env.DB, org.id)).find((m) => m.role === 'owner')!.email;
    const ask = async (name: string) => {
      const spot = await o.spots.insert({ name, kind: 'url', durationMs: 10_000, url: `https://example.com/${name}` });
      const r = await dispatch(
        registry,
        'request_publish',
        { drafts: [{ kind: 'spot', id: spot.id, version: spot.rowVersion }], reason: 'SECRET-REASON-TEXT' },
        { org: scoped(env.DB, org.id), role: 'editor', actor: { kind: 'user', id: asker.userId, clientId: 'cms' }, blobs: env.BLOBS, services: {} },
      );
      if (!r.ok) throw new Error(JSON.stringify(r));
      return (r.output as { request: { id: string; expiresAt: number } }).request;
    };
    const { guards, to } = receivers({ [slackUrl]: [200], [webhookUrl]: [200] });
    const start = Date.now();
    const request = await ask('menu');
    // One run sends Slack and the webhook, and fans the email out to each approver, sending those too (#396).
    await deliverAlerts(env, outbox, { now: start + MIN, guards });
    const asks = (addr: string) => outbox.messages.filter((m) => m.to === addr && m.subject.includes('asks to publish'));
    for (const addr of [ownerEmail, other.email]) {
      expect(asks(addr), addr).toEqual([
        {
          to: addr,
          subject: `SignForge: Ada asks to publish 1 draft in ${org.name}`,
          text: `Ada asks to publish 1 draft in ${org.name}. Approve or decline it in SignForge before ${new Date(request.expiresAt).toISOString()} (UTC); after that it expires.\n\nWho gets these is in Settings, Notifications.`,
        },
      ]);
    }
    expect([...asks(asker.email), ...asks(viewer.email)]).toEqual([]);
    const event = await to(webhookUrl)[0]!.json();
    expect(event).toEqual({
      type: 'publish.requested',
      id: `evt_publish_requested_${request.id}`,
      occurredAt: expect.any(String),
      org: { id: org.id, name: org.name },
      data: {
        request: { id: request.id, url: null, drafts: 1, expiresAt: new Date(request.expiresAt).toISOString() },
        by: { kind: 'user', id: asker.userId, name: 'Ada' },
      },
    });
    const slack = await to(slackUrl)[0]!.json<{ text: string; blocks: unknown[] }>();
    expect(slack.text).toBe(`Ada asks to publish 1 draft in ${org.name}`);
    expect(JSON.stringify(slack.blocks)).toContain('*Decide by*');
    for (const body of [JSON.stringify(event), JSON.stringify(slack), JSON.stringify(outbox.messages)]) expect(body).not.toContain('SECRET-REASON-TEXT');

    // While only owners publish, an editor is not asked to approve: the email goes to whoever may when it is sent.
    await owner.ok('/api/tools/update_org_settings', { editorsPublish: false });
    const specials = await ask('specials');
    // Sent at once, as the call's `deliverNow` does: the approvers' emails with it, not at the next run (#396).
    const [fanOut] = (await o.alertDeliveries.list({ take: 50 })).filter((d) => d.eventId === `evt_publish_requested_${specials.id}` && d.channel === 'email');
    await deliverAlert(env, outbox, org.id, fanOut!.id, { now: start + 2 * MIN, guards });
    expect(asks(ownerEmail)).toHaveLength(2);
    expect(asks(other.email)).toHaveLength(1);

    // One mailbox that fails stops no other, and its retry sends to it alone (re-check of #386).
    await owner.ok('/api/tools/update_org_settings', { editorsPublish: true });
    const failing = {
      send: async (m: { to: string; subject: string; text: string }) => (m.to === other.email ? Promise.reject(new Error('mailbox full')) : outbox.send(m)),
    };
    await ask('lunch');
    await deliverAlerts(env, failing, { now: start + 3 * MIN, guards });
    expect(asks(ownerEmail)).toHaveLength(3);
    expect(asks(other.email)).toHaveLength(1);
    await deliverAlerts(env, outbox, { now: start + 3 * MIN + HOUR, guards });
    expect(asks(ownerEmail)).toHaveLength(3);
    expect(asks(other.email)).toHaveLength(2);
  });

  it("sends an agent's repeated refusals to Slack and the webhook once an hour, naming its client as a page does (M4-08)", async () => {
    const { owner, org, slackUrl, webhookUrl, outbox } = await orgWithChannels();
    await owner.ok('/api/tools/update_org_settings', { alerts: { agent_refused: { slack: true, webhook: true } } });
    const { clientId, access_token } = await agentToken(owner.t, owner, org.id, ['content:read']);
    const { grantId } = (await check(access_token))!;
    const { guards, to } = receivers({ [slackUrl]: [200], [webhookUrl]: [200] });
    const cms = { ...env, CMS_ORIGIN: 'https://cms.test' };
    const start = Date.now();
    const hour = start - (start % HOUR);
    const refused = { orgId: org.id, grantId, tool: 'update_screen', needs: 'screens:manage', refusals: 3, hour };
    // Twice in one hour, as two calls racing past the object might: one event.
    await alertAgentRefused(cms, outbox, refused, start);
    await alertAgentRefused(cms, outbox, refused, start + MIN);
    await deliverAlerts(env, outbox, { now: start + MIN, guards });
    expect([to(slackUrl).length, to(webhookUrl).length]).toEqual([1, 1]);
    expect(await to(webhookUrl)[0]!.json()).toEqual({
      type: 'agent.refused',
      id: `evt_agent_refused_${grantId}_${hour}`,
      occurredAt: new Date(start).toISOString(),
      org: { id: org.id, name: org.name },
      data: {
        grant: { id: grantId, url: `https://cms.test/settings/api/${grantId}`, client: { id: clientId, name: 'Test agent' } },
        refusals: 3,
        tool: 'update_screen',
        needs: 'screens:manage',
      },
    });
    const slack = await to(slackUrl)[0]!.json<{ text: string; blocks: unknown[] }>();
    expect(slack.text).toBe(`The agent “Test agent” in ${org.name} was refused 3 times this hour`);
    expect(JSON.stringify(slack.blocks)).toContain(`<https://cms.test/settings/api/${grantId}|Open the agent in SignForge>`);

    // A grant disconnected since: nobody is told.
    await owner.ok('/api/tools/revoke_agent_grant', { grantId });
    await alertAgentRefused(cms, outbox, { ...refused, hour: hour + HOUR }, start + HOUR);
    await deliverAlerts(env, outbox, { now: start + HOUR, guards });
    expect([to(slackUrl).length, to(webhookUrl).length]).toEqual([1, 1]);
  });

  it("escapes a screen's name in Slack's notification text as in its blocks", async () => {
    const { org, slackUrl, webhookUrl, outbox } = await orgWithChannels();
    const start = Date.now();
    await pairedScreen(org.id, '<!here> <https://evil.test|click> & co', start);
    const { guards, to } = receivers({ [slackUrl]: [200], [webhookUrl]: [200] });
    await checkScreenAlerts(env, outbox, start + 16 * MIN);
    await deliverAlerts(env, outbox, { now: start + 16 * MIN, guards });

    const body = await to(slackUrl)[0]!.text();
    expect(body).not.toContain('<!here>');
    expect(body).not.toContain('<https://evil.test');
    expect(JSON.parse(body).text).toBe(`&lt;!here&gt; &lt;https://evil.test|click&gt; &amp; co in ${org.name} is offline`);
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
    const o = testScope(env.DB, org.id);
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

  it('retries, rather than gives up, while the key that opens the channels is missing', async () => {
    const { owner, org, slackUrl, webhookUrl, outbox } = await orgWithChannels();
    const start = Date.now();
    await pairedScreen(org.id, 'No key yet', start);
    const { guards, to } = receivers({ [slackUrl]: [200], [webhookUrl]: [200] });
    await checkScreenAlerts(env, outbox, start + 16 * MIN);
    // A deploy without the secret: outside dev there is no fallback key.
    await deliverAlerts({ ...env, ENVIRONMENT: 'demo', DATA_SOURCE_KEY: undefined }, outbox, { now: start + 16 * MIN, guards });
    expect([to(slackUrl), to(webhookUrl)]).toEqual([[], []]);
    for (const d of (await log(owner)).filter((x) => x.eventType === 'screen.offline'))
      expect(d).toMatchObject({ status: 'pending', lastError: 'no-key', lastHttpStatus: null });

    // Set again: the next try goes.
    await deliverAlerts(env, outbox, { now: start + 21 * MIN, guards });
    expect([to(slackUrl).length, to(webhookUrl).length]).toEqual([1, 1]);
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
    const o = testScope(env.DB, org.id);
    const stored = JSON.stringify([await o.alertChannels.list(), await o.auditLog.list({ limit: 100 })]);
    for (const secret of [slackUrl, 'secretpart', webhookUrl, 'key=k', SECRET]) expect(stored).not.toContain(secret);
  });
});

describe("a delivery run's D1 queries", () => {
  it("stay a handful however many it sends, well under the Free plan's 50 an invocation", async () => {
    const now = Date.now();
    const answers: Record<string, number[]> = {};
    for (let i = 0; i < 3; i++) {
      const { org, webhookUrl } = await orgWithChannels();
      answers[webhookUrl] = [200];
      const o = testScope(env.DB, org.id);
      const event = { type: 'test', occurredAt: new Date(now).toISOString(), org: { id: org.id, name: org.name }, data: { message: 'Budget' } };
      await o.commit(
        [0, 1, 2, 3].flatMap(
          (n) =>
            o.alertDeliveries.stage.insert({
              channel: 'webhook',
              eventId: `evt_budget_${n}`,
              eventType: 'test',
              eventJson: JSON.stringify({ ...event, id: `evt_budget_${n}` }),
              nextAttemptAt: now,
              giveUpAt: now,
            }).writes,
        ),
      );
    }
    const { guards, to } = receivers(answers);
    const watched = watchedD1(env.DB);

    await deliverAlerts({ ...env, DB: watched.db }, new RecordingEmailSender(), { now, guards });
    expect(Object.keys(answers).flatMap((url) => to(url))).toHaveLength(12);
    expect(watched.seen.queries).toBeLessThanOrEqual(3);
  });
});

describe('when the delivery queue cannot be written', () => {
  it('still emails the alert, opens the incident once, and alerts no more on the next check', async () => {
    const { org, outbox } = await orgWithChannels();
    const start = Date.now();
    await pairedScreen(org.id, 'Queue down', start);
    const broken = watchedD1(env.DB, /insert into "alert_deliveries"/i);
    const sent = () => outbox.messages.filter((m) => m.subject === 'Queue down is offline');

    await checkScreenAlerts({ ...env, DB: broken.db }, outbox, start + 16 * MIN);
    expect(sent()).toHaveLength(1);
    // The next check, healthy, finds the incident open and sends nothing more.
    await checkScreenAlerts(env, outbox, start + 21 * MIN);
    expect(sent()).toHaveLength(1);
  });

  it('queues the alert once when two checks overlap', async () => {
    const { owner, org, outbox } = await orgWithChannels();
    const start = Date.now();
    await pairedScreen(org.id, 'Twice', start);
    await Promise.all([checkScreenAlerts(env, outbox, start + 16 * MIN), checkScreenAlerts(env, outbox, start + 16 * MIN)]);
    expect(
      (await log(owner))
        .filter((d) => d.eventType === 'screen.offline')
        .map((d) => d.channel)
        .sort(),
    ).toEqual(['slack', 'webhook']);
    expect(outbox.messages.filter((m) => m.subject === 'Twice is offline')).toHaveLength(1);
  });
});

describe('the five-minute Cron Trigger', () => {
  /** An email test delivery to the org's owner, due at `due`, with `message` as its subject's end. */
  async function emailDue(message: string, due: number) {
    const { org } = await orgWithChannels();
    const o = testScope(env.DB, org.id);
    const outbox = emailSenderFor(env);
    if (!(outbox instanceof RecordingEmailSender)) throw new Error('dev should send through the recorder');
    const [member] = await orgMembers(env.DB, org.id);
    const now = due;
    await o.commit(
      o.alertDeliveries.stage.insert({
        channel: 'email',
        eventId: `evt_${message.replace(/\W/g, '_')}`,
        eventType: 'test',
        eventJson: JSON.stringify({
          type: 'test',
          id: `evt_${message.replace(/\W/g, '_')}`,
          occurredAt: new Date(now).toISOString(),
          org: { id: org.id, name: org.name },
          data: { message },
        }),
        toUserId: member!.userId,
        nextAttemptAt: now,
        giveUpAt: now,
      }).writes,
    );
    const sent = () => outbox.messages.filter((m) => m.subject === `SignForge: ${message}`).map((m) => m.to);
    return { o, member: member!, sent };
  }

  const run = async (cron: string, scheduledTime: number) => {
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime, cron }), env, ctx);
    await waitOnExecutionContext(ctx);
  };

  it('sends the deliveries that are due once the alert check has run', async () => {
    const now = Date.now();
    const { member, sent } = await emailDue('Cron test', now);
    await run('* * * * *', now);
    expect(sent()).toEqual([]);
    await run('*/5 * * * *', now);
    expect(sent()).toEqual([member.email]);
  });

  it("claims at the time it claims, not the run's scheduled time, so a late run holds its lease in full", async () => {
    const claimedAfter = Date.now();
    const { o, member, sent } = await emailDue('Late run', claimedAfter);
    // A run scheduled 10 minutes ago (its check took that long): the delivery, due now, is still claimed and sent.
    await run('*/5 * * * *', claimedAfter - 10 * MIN);
    expect(sent()).toEqual([member.email]);
    const [row] = await o.alertDeliveries.list({ take: 1 });
    expect(row!.lastAttemptAt).toBeGreaterThanOrEqual(claimedAfter);
  });
});
