// The alert delivery queue (#88): an event is queued once per channel, each attempt is claimed by
// one run, and the log is kept 7 days.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { claimDueAlertDeliveries, expireAlertDeliveries, scoped } from '../src/index';
import { seedTwoOrgs, type Seeded } from '../src/testing';

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

  it('lets one run claim each due attempt, in every org, and none before its time', async () => {
    const at = now + 10 * DAY;
    await queue(s.a.orgId, 'evt_claim_a', ['webhook'], at, at + DAY);
    await queue(s.b.orgId, 'evt_claim_b', ['webhook'], at, at + DAY);
    await queue(s.b.orgId, 'evt_later', ['webhook'], at + MIN, at + DAY);

    const [first, second] = await Promise.all([
      claimDueAlertDeliveries(env.DB, at, { limit: 50, leaseMs: 4 * MIN }),
      claimDueAlertDeliveries(env.DB, at, { limit: 50, leaseMs: 4 * MIN }),
    ]);
    const claimed = [...first!, ...second!];
    const [a] = await mine(s.a.orgId, 'evt_claim_a');
    const [b] = await mine(s.b.orgId, 'evt_claim_b');
    expect(claimed.filter((c) => c.id === a!.id || c.id === b!.id).sort((x, y) => x.orgId.localeCompare(y.orgId))).toEqual([
      { orgId: s.a.orgId, id: a!.id },
      { orgId: s.b.orgId, id: b!.id },
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
    await a.alertDeliveries.settle(slack!.id, at, { ok: true, httpStatus: 200 });
    await a.alertDeliveries.settle(webhook!.id, at, { ok: false, httpStatus: 500, error: 'http-status', retryAt: at + 5 * MIN });
    expect(await a.alertDeliveries.get(slack!.id)).toMatchObject({ status: 'delivered', lastHttpStatus: 200, lastError: null });
    expect(await a.alertDeliveries.get(webhook!.id)).toMatchObject({
      status: 'pending',
      lastHttpStatus: 500,
      lastError: 'http-status',
      nextAttemptAt: at + 5 * MIN,
    });

    await a.alertDeliveries.settle(webhook!.id, at, { ok: false, httpStatus: 500, error: 'http-status' });
    expect(await a.alertDeliveries.get(webhook!.id)).toMatchObject({ status: 'failed' });
    const due = await claimDueAlertDeliveries(env.DB, at + DAY, { limit: 50, leaseMs: MIN });
    expect(due.map((d) => d.id)).not.toEqual(expect.arrayContaining([slack!.id]));
    expect(due.map((d) => d.id)).not.toEqual(expect.arrayContaining([webhook!.id]));
  });

  it("deletes each org's deliveries once they are 7 days old", async () => {
    const at = now + 40 * DAY;
    await queue(s.a.orgId, 'evt_old', ['webhook'], at - 8 * DAY, at);
    await queue(s.b.orgId, 'evt_recent', ['webhook'], at - 6 * DAY, at);
    await expireAlertDeliveries(env.DB, at);
    expect(await mine(s.a.orgId, 'evt_old')).toEqual([]);
    expect(await mine(s.b.orgId, 'evt_recent')).toHaveLength(1);
  });
});
