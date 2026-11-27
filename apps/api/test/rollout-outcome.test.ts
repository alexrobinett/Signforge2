// The rollout outcome (#155): the publish page (get_publish, which list_publishes shares) and the
// finished-publish alert (the five-minute check, its webhook payload and its email) read one rule,
// so on every case they say the same: each screen's outcome, the counts, and when it is over.
// No network: the webhook's fetch is stubbed, and every time is a parameter.
import { testScope } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { finishRollouts } from '../src/alerts';
import type { FetchGuards } from '../src/data/fetch';
import { deliverAlerts } from '../src/deliveries';
import { Client, email, testApp } from './client';

const MIN = 60_000;
const SECRET = 'whsec_0123456789abcdefghijklmnopqrstuvwxyzABCD';
const m = (c: string) => c.repeat(64);

type Outcome = 'playing' | 'downloading' | 'asleep' | 'unreachable' | 'waiting' | 'fell_back' | 'revoked' | 'replaced';
interface Page {
  publish: {
    id: string;
    revision: number;
    screens: number;
    playing: number;
    replaced: number;
    open: number;
    reached: number | null;
    finishedAt: number | null;
  };
  screens: { name: string; outcome: Outcome }[];
}

let orgs = 0;
/** An org whose finished-publish alert goes to a webhook, with screens named `names`, each paired and heard from at `now`. */
async function orgWith(names: string[], now: number) {
  const n = ++orgs;
  const t = testApp();
  const owner = new Client(t);
  await owner.signIn(email(`rollout-${n}`));
  const org = await owner.createOrg(`Rollout ${n}`);
  const webhookUrl = `https://ops${n}.example.com/hooks/sf`;
  await owner.ok('/api/tools/set_alert_channel', { kind: 'webhook', webhookUrl, signingSecret: SECRET });
  await owner.ok('/api/tools/update_org_settings', { alerts: { publish_finished: { webhook: true } } });
  const o = testScope(env.DB, org.id);
  const screens: Record<string, { id: string; credential: string }> = {};
  for (const name of names) {
    const s = await o.screens.insert({ name, timezone: 'UTC', orientation: 'landscape', lastSeenAt: now, kind: 'device' });
    const c = await o.screens.credentials.insert({ screenId: s.id, secretHash: '0'.repeat(64) });
    screens[name] = { id: s.id, credential: c.id };
  }
  let revision = 0;
  /** A publish switching each named screen to its manifest, as the publish tool commits it. */
  const publish = async (to: Record<string, string>) => {
    const p = o.publishes.stage.insert({ status: 'published', actorKind: 'user', actorId: 'user-1', revision: ++revision });
    const rows = Object.entries(to).map(([name, manifestId]) => ({ screenId: screens[name]!.id, manifestId }));
    await o.commit([
      ...p.writes,
      ...o.publishes.stage.addScreens(p.row.id, rows).writes,
      ...rows.flatMap((r) => o.screens.stage.setDesiredManifest(r.screenId, r.manifestId, null).writes),
    ]);
    return p.row.id;
  };
  const report = (name: string, manifestId: string, at: number) => o.screens.reportManifest(screens[name]!.id, manifestId, { arrivedAt: at });
  const revokeCredential = (name: string, at: number) => o.screens.credentials.update(screens[name]!.credential, { revokedAt: at });
  const revokeScreen = (name: string) => o.screens.update(screens[name]!.id, { status: 'revoked' });
  return { owner, outbox: t.outbox, webhookUrl, o, publish, report, revokeCredential, revokeScreen };
}

type Org = Awaited<ReturnType<typeof orgWith>>;

/** What the publish page shows for `publishId`, and what the alert check does with it at `now`. */
async function bothSides(org: Org, publishId: string, now: number) {
  const page = await org.owner.ok<Page>('/api/tools/get_publish', { publishId });
  const requests: Request[] = [];
  const guards: FetchGuards = {
    resolve: async () => ['93.184.216.34'],
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return new Response('ok');
    },
  };
  await finishRollouts(env, org.outbox, now);
  await deliverAlerts(env, org.outbox, { now, guards });
  const events = await Promise.all(
    requests.map((r) => r.json<{ type: string; data: { publish: { id: string }; screens: number; playing: number; replaced: number } }>()),
  );
  const alert = events.find((e) => e.type === 'publish.finished' && e.data.publish.id === publishId);
  const mail = org.outbox.messages.find((msg) => msg.subject.startsWith(`v${page.publish.revision} `));
  const marked = (await org.o.publishes.get(publishId))!;
  const count = (outcome: Outcome) => page.screens.filter((s) => s.outcome === outcome).length;
  const settled = count('playing') + count('replaced') + count('revoked');
  // The page agrees with itself: its counts are its screens' outcomes.
  expect(page.publish).toMatchObject({
    screens: page.screens.length,
    playing: count('playing'),
    replaced: count('replaced'),
    open: page.screens.length - settled,
  });
  // And with the check: over exactly when the page has no screen open, marked with what it saw playing.
  expect(marked.finishedAt === null).toBe(page.publish.open > 0);
  if (marked.finishedAt !== null) expect(marked.reached).toBe(page.publish.playing);
  // The alert, when one goes, carries the page's counts; the email's "revoked" is the page's revoked screens.
  if (alert) {
    expect(alert.data).toEqual({ publish: alert.data.publish, screens: page.publish.screens, playing: page.publish.playing, replaced: page.publish.replaced });
    expect(mail?.text.includes(`${count('revoked')} revoked`) ?? false).toBe(count('revoked') > 0);
  }
  return {
    outcomes: Object.fromEntries(page.screens.map((s) => [s.name, s.outcome])),
    counts: { screens: page.publish.screens, playing: page.publish.playing, replaced: page.publish.replaced, open: page.publish.open },
    finished: marked.finishedAt !== null,
    alert: alert ? alert.data : null,
  };
}

describe('the publish page and the finished-publish alert', () => {
  it("agree on #127's re-check: played then switched, revoked before playing, switched unplayed, played then revoked", async () => {
    const start = Date.now();
    const org = await orgWith(['A', 'B', 'C', 'D'], start);
    const v1 = await org.publish({ A: m('1'), B: m('2'), C: m('3'), D: m('4') });
    await org.report('A', m('1'), start);
    await org.report('D', m('4'), start);
    await org.revokeCredential('B', start);
    await org.revokeScreen('D');
    // v2 switches A, still reporting v1, and C, which never played it.
    await org.publish({ A: m('5'), C: m('6') });
    expect(await bothSides(org, v1, start + MIN)).toEqual({
      outcomes: { A: 'playing', B: 'revoked', C: 'replaced', D: 'playing' },
      counts: { screens: 4, playing: 2, replaced: 1, open: 0 },
      finished: true,
      alert: expect.objectContaining({ screens: 4, playing: 2, replaced: 1 }),
    });
  });

  it('agree that a screen still reporting a publish a later one switched is playing it, never also replaced', async () => {
    const start = Date.now();
    const org = await orgWith(['Till 1', 'Till 2'], start);
    const v1 = await org.publish({ 'Till 1': m('1'), 'Till 2': m('2') });
    await org.report('Till 1', m('1'), start);
    await org.report('Till 2', m('2'), start);
    await org.publish({ 'Till 1': m('5'), 'Till 2': m('6') });
    expect(await bothSides(org, v1, start + MIN)).toEqual({
      outcomes: { 'Till 1': 'playing', 'Till 2': 'playing' },
      counts: { screens: 2, playing: 2, replaced: 0, open: 0 },
      finished: true,
      alert: expect.objectContaining({ screens: 2, playing: 2, replaced: 0 }),
    });
  });

  it('agree that a publish undone before any screen played it is over, with no alert', async () => {
    const start = Date.now();
    const org = await orgWith(['Till 1', 'Till 2'], start);
    const v1 = await org.publish({ 'Till 1': m('1'), 'Till 2': m('2') });
    await org.publish({ 'Till 1': m('d'), 'Till 2': m('e') });
    expect(await bothSides(org, v1, start + MIN)).toEqual({
      outcomes: { 'Till 1': 'replaced', 'Till 2': 'replaced' },
      counts: { screens: 2, playing: 0, replaced: 2, open: 0 },
      finished: true,
      alert: null,
    });
  });

  it('agree that one screen playing and one revoked is over: the page says no screen is left to wait on', async () => {
    const start = Date.now();
    const org = await orgWith(['Lobby', 'Annex'], start);
    const v1 = await org.publish({ Lobby: m('1'), Annex: m('2') });
    await org.report('Lobby', m('1'), start);
    await org.revokeCredential('Annex', start);
    expect(await bothSides(org, v1, start + MIN)).toEqual({
      outcomes: { Lobby: 'playing', Annex: 'revoked' },
      counts: { screens: 2, playing: 1, replaced: 0, open: 0 },
      finished: true,
      alert: expect.objectContaining({ screens: 2, playing: 1, replaced: 0 }),
    });
  });

  it('agree that a screen offline or still switching holds the rollout open', async () => {
    const start = Date.now();
    const org = await orgWith(['Lobby', 'Annex', 'Cellar'], start);
    const v1 = await org.publish({ Lobby: m('1'), Annex: m('2'), Cellar: m('3') });
    await org.report('Lobby', m('1'), start);
    // Annex was last heard from an hour ago, past the 15 minutes; Cellar is online and fetching it.
    await org.o.screens.update((await org.o.publishes.rollout(v1)).find((r) => r.name === 'Annex')!.id, { lastSeenAt: start - 60 * MIN });
    expect(await bothSides(org, v1, start + MIN)).toEqual({
      outcomes: { Lobby: 'playing', Annex: 'unreachable', Cellar: 'downloading' },
      counts: { screens: 3, playing: 1, replaced: 0, open: 2 },
      finished: false,
      alert: null,
    });
  });

  it('agree that a publish that switched no screen is over at once, with no alert', async () => {
    const start = Date.now();
    const org = await orgWith(['Lobby'], start);
    const v1 = await org.publish({});
    expect(await bothSides(org, v1, start + MIN)).toEqual({
      outcomes: {},
      counts: { screens: 0, playing: 0, replaced: 0, open: 0 },
      finished: true,
      alert: null,
    });
  });
});
