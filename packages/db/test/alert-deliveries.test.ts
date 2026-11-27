// The alert delivery queue (#88): an event is queued once per channel, each attempt is claimed by
// one run, and the log is kept 7 days.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { alertChannelsOf, claimDueAlertDeliveries, expireAlertDeliveries, scoped } from '../src/index';
import { seedOrg, seedTwoOrgs, type Seeded } from '../src/testing';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const now = Date.UTC(2027, 0, 4, 9);

let s: Seeded;
beforeAll(async () => {
  s = await seedTwoOrgs(env.DB);
});

const event = (id: string) => ({ id, type: 'screen.offline', json: JSON.stringify({ id }) });
/** Queue `eventId` for `channels` at `at`, as rows straight in the table. */
async function queue(orgId: string, eventId: string, channels: ('slack' | 'webhook')[], at: number, giveUpAt: number) {
  const o = scoped(env.DB, orgId);
  const e = event(eventId);
  await o.commit(
    channels.flatMap(
      (channel) => o.alertDeliveries.stage.insert({ channel, eventId: e.id, eventType: e.type, eventJson: e.json, nextAttemptAt: at, giveUpAt }).writes,
    ),
  );
  // Made at `at`: a caller never sets `created_at`.
  await env.DB.prepare('UPDATE alert_deliveries SET created_at = ? WHERE event_id = ?').bind(at, eventId).run();
}
const mine = async (orgId: string, eventId: string) => (await scoped(env.DB, orgId).alertDeliveries.list({ take: 100 })).filter((d) => d.eventId === eventId);

describe('alert deliveries', () => {
  it('writes an incident with its alert, once however often it is opened or cleared', async () => {
    const a = scoped(env.DB, s.a.orgId);
    const alert = (id: string) => ({ event: event(id), channels: ['slack', 'webhook'] as const, giveUpAt: now + DAY });
    const [first, second] = await Promise.all([
      a.incidents.open(s.a.screen, now - DAY, now, (inc) => alert(`evt_${inc}_offline`)),
      a.incidents.open(s.a.screen, now - DAY, now, (inc) => alert(`evt_${inc}_offline`)),
    ]);
    const incident = first ?? second;
    expect([first, second].filter(Boolean)).toEqual([incident]);
    expect((await mine(s.a.orgId, `evt_${incident}_offline`)).map((d) => [d.channel, d.status, d.nextAttemptAt]).sort()).toEqual([
      ['slack', 'pending', now],
      ['webhook', 'pending', now],
    ]);

    expect(await a.incidents.clear(incident!, now + MIN, alert(`evt_${incident}_back`))).toBe(true);
    expect(await a.incidents.clear(incident!, now + 2 * MIN, alert(`evt_${incident}_back`))).toBe(false);
    expect(await mine(s.a.orgId, `evt_${incident}_back`)).toHaveLength(2);
  });

  it("queues no alert for an incident or publish that is missing or another org's", async () => {
    const a = scoped(env.DB, s.a.orgId);
    const b = scoped(env.DB, s.b.orgId);
    const alert = (id: string) => ({ event: event(id), channels: ['slack', 'webhook'] as const, giveUpAt: now + DAY });
    const theirs = await a.incidents.open(s.a.screen, now - DAY, now + 3 * DAY);
    expect(theirs).toBeDefined();

    expect(await b.incidents.clear('inc_missing', now + 3 * DAY, alert('evt_clear_missing'))).toBe(false);
    expect(await b.incidents.clear(theirs!, now + 3 * DAY, alert('evt_clear_theirs'))).toBe(false);
    expect(await b.publishes.finish('pub_missing', now + 3 * DAY, 0, alert('evt_finish_missing'))).toBe(false);
    expect(await b.publishes.finish(s.a.publish, now + 3 * DAY, 0, alert('evt_finish_theirs'))).toBe(false);

    for (const id of ['evt_clear_missing', 'evt_clear_theirs', 'evt_finish_missing', 'evt_finish_theirs'])
      for (const org of [s.a.orgId, s.b.orgId]) expect(await mine(org, id), `${org}: ${id}`).toEqual([]);
    expect(await a.incidents.clear(theirs!, now + 3 * DAY)).toBe(true);
  });

  it('reads the channels of more deliveries than D1 binds in one statement, each channel once', async () => {
    const { orgId } = await seedOrg(env.DB, 'org-many-channels');
    const o = scoped(env.DB, orgId);
    const channel = { host: 'hooks.slack.test', urlEncrypted: 'sealed:url', secretEncrypted: null, secretSetAt: null, connectedBy: 'u' };
    await o.commit((await o.alertChannels.stage.put('slack', channel)).writes);
    const slack = { orgId, channel: 'slack' as const };
    const elsewhere = Array.from({ length: 120 }, (_, i) => ({ orgId: `org-without-${i}`, channel: 'webhook' as const }));

    const found = await alertChannelsOf(env.DB, [slack, ...elsewhere, slack]);
    expect(found.map((c) => [c.orgId, c.kind])).toEqual([[orgId, 'slack']]);
  });

  it('lets one run claim each due attempt, in every org, and none before its time', async () => {
    const at = now + 10 * DAY;
    await queue(s.a.orgId, 'evt_claim_a', ['webhook'], at, at + DAY);
    await queue(s.b.orgId, 'evt_claim_b', ['webhook'], at, at + DAY);
    await queue(s.b.orgId, 'evt_later', ['webhook'], at + MIN, at + DAY);

    const [first, second] = await Promise.all([
      claimDueAlertDeliveries(env.DB, at, { limit: 50, leaseMs: 4 * MIN }),
      claimDueAlertDeliveries(env.DB, at, { limit: 50, leaseMs: 4 * MIN }),
    ]);
    const claimed = [...first!, ...second!].map(({ orgId, id, attempts }) => ({ orgId, id, attempts }));
    const [a] = await mine(s.a.orgId, 'evt_claim_a');
    const [b] = await mine(s.b.orgId, 'evt_claim_b');
    expect(claimed.filter((c) => c.id === a!.id || c.id === b!.id).sort((x, y) => x.orgId.localeCompare(y.orgId))).toEqual([
      { orgId: s.a.orgId, id: a!.id, attempts: 1 },
      { orgId: s.b.orgId, id: b!.id, attempts: 1 },
    ]);
    expect(claimed.map((c) => c.id)).not.toContain((await mine(s.b.orgId, 'evt_later'))[0]!.id);
    expect([a!.attempts, a!.lastAttemptAt, a!.nextAttemptAt]).toEqual([1, at, at + 4 * MIN]);

    // Held for the lease, by the cross-org claim and by one org's.
    expect(await scoped(env.DB, s.a.orgId).alertDeliveries.claim(a!.id, at + MIN, 4 * MIN)).toBeUndefined();
    expect((await claimDueAlertDeliveries(env.DB, at + MIN, { limit: 50, leaseMs: 4 * MIN })).map((c) => c.id)).not.toContain(a!.id);
    // Not another org's to claim.
    expect(await scoped(env.DB, s.b.orgId).alertDeliveries.claim(a!.id, at + 5 * MIN, 4 * MIN)).toBeUndefined();
    expect((await scoped(env.DB, s.a.orgId).alertDeliveries.claim(a!.id, at + 5 * MIN, 4 * MIN))?.attempts).toBe(2);
  });

  it('settles an attempt as delivered, to retry, or given up, and claims none of those early', async () => {
    const a = scoped(env.DB, s.a.orgId);
    const at = now + 20 * DAY;
    await queue(s.a.orgId, 'evt_settle', ['slack', 'webhook'], at, at + DAY);
    const [slack, webhook] = (await mine(s.a.orgId, 'evt_settle')).sort((x, y) => x.channel.localeCompare(y.channel));
    await a.alertDeliveries.claim(slack!.id, at, MIN);
    await a.alertDeliveries.claim(webhook!.id, at, MIN);
    // An attempt that is not the latest settles nothing.
    await a.alertDeliveries.settle(slack!.id, 0, at, { ok: false, httpStatus: 500, error: 'http-status' });
    expect(await a.alertDeliveries.get(slack!.id)).toMatchObject({ status: 'pending', lastError: null, leasedUntil: at + MIN });
    await a.alertDeliveries.settle(slack!.id, 1, at, { ok: true, httpStatus: 200 });
    await a.alertDeliveries.settle(webhook!.id, 1, at, { ok: false, httpStatus: 500, error: 'http-status', retryAt: at + 5 * MIN });
    expect(await a.alertDeliveries.get(slack!.id)).toMatchObject({ status: 'delivered', lastHttpStatus: 200, lastError: null, leasedUntil: null });
    expect(await a.alertDeliveries.get(webhook!.id)).toMatchObject({
      status: 'pending',
      lastHttpStatus: 500,
      lastError: 'http-status',
      nextAttemptAt: at + 5 * MIN,
    });

    await a.alertDeliveries.claim(webhook!.id, at + 5 * MIN, MIN);
    await a.alertDeliveries.settle(webhook!.id, 2, at + 5 * MIN, { ok: false, httpStatus: 500, error: 'http-status' });
    expect(await a.alertDeliveries.get(webhook!.id)).toMatchObject({ status: 'failed' });
    const due = await claimDueAlertDeliveries(env.DB, at + DAY, { limit: 50, leaseMs: MIN });
    expect(due.map((d) => d.id)).not.toEqual(expect.arrayContaining([slack!.id]));
    expect(due.map((d) => d.id)).not.toEqual(expect.arrayContaining([webhook!.id]));
  });

  it('leaves a delivery delivered when a retry staged before its delivery commits after it', async () => {
    const a = scoped(env.DB, s.a.orgId);
    const at = now + 30 * DAY;
    await queue(s.a.orgId, 'evt_retry_race', ['webhook'], at, at + DAY);
    const [read] = await mine(s.a.orgId, 'evt_retry_race');
    const retry = a.alertDeliveries.stage.retry(read!, at);
    // Delivered between the read and the commit.
    await a.alertDeliveries.claim(read!.id, at, MIN);
    await a.alertDeliveries.settle(read!.id, 1, at, { ok: true, httpStatus: 200 });
    await a.commit(retry.writes);
    expect(await a.alertDeliveries.get(read!.id)).toMatchObject({ status: 'delivered', lastHttpStatus: 200 });
  });

  it("deletes each org's deliveries once they are 7 days old", async () => {
    const at = now + 40 * DAY;
    await queue(s.a.orgId, 'evt_old', ['webhook'], at - 8 * DAY, at);
    await queue(s.b.orgId, 'evt_recent', ['webhook'], at - 6 * DAY, at);
    await queue(s.b.orgId, 'evt_old_b', ['slack', 'webhook'], at - 9 * DAY, at);
    // Org by org, in batches, as audit rows go; it says how many went.
    const old = await env.DB.prepare('SELECT count(*) AS n FROM alert_deliveries WHERE created_at < ?')
      .bind(at - 7 * DAY)
      .first<{ n: number }>();
    expect(old!.n).toBeGreaterThanOrEqual(3);
    expect(await expireAlertDeliveries(env.DB, at)).toBe(old!.n);
    expect(await mine(s.b.orgId, 'evt_old_b')).toEqual([]);
    expect(await mine(s.a.orgId, 'evt_old')).toEqual([]);
    expect(await mine(s.b.orgId, 'evt_recent')).toHaveLength(1);
  });
});
