// The day's budget of new feed photos (#481, owner decision on #339): each source its fair share of the org's day,
// whatever order they poll in, and the org's day a hard ceiling however many source ids hold photos. Run as the poller
// saves a poll (`savePoll`'s hold), on the test's own clock.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { NEW_PER_ORG_PER_DAY, NEW_PER_SOURCE_PER_DAY } from '../src';
import { seedTwoOrgs, type Seeded } from '../src/testing';

let s: Seeded;
beforeAll(async () => {
  s = await seedTwoOrgs(env.DB);
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
let T = 2_000_000_000_000;

type Org = Seeded['a'];

/** A full read of a feed whose photos a screen shows, as the poller saves it: it records the stories' photo URLs. */
const hold = async (org: Org, sourceId: string, fresh: readonly string[], now: number) => {
  const row = (await org.scope.dataSources.get(sourceId))!;
  const { held } = await org.scope.dataSources.savePoll(sourceId, {
    source: { nextPollAt: now + HOUR, failures: 0, lastError: null },
    photos: {
      read: { rowVersion: row.rowVersion, generation: row.photoGeneration, now, readWhole: false, lastSeen: [] },
      stories: { version: `v-${now}`, urls: [...fresh] },
      hold: { again: [], fresh },
    },
  });
  return held;
};
const add = (org: Org, id: string) => org.scope.dataSources.insert({ id, name: id, format: 'rss', urlEncrypted: 'enc', refreshS: 3600 });
/** Each test its own days, and only its own sources with photos on. */
async function fresh(org: Org) {
  T += 30 * DAY;
  for (const d of await org.scope.dataSources.list()) await org.scope.dataSources.update(d.id, { photos: false });
}
let serial = 0;
const unseen = (id: string, n = 10) => Array.from({ length: n }, () => `https://${id}.example/${serial++}.jpg`);

/**
 * `feeds` busy feeds, ten unseen photos every hourly poll for `days`, in this order every hour: what each held per day.
 * Each was shown before the first day, by a read with no photos new, unless `newAt` says when it was added and first shown.
 */
async function busy(feeds: string[], days: number, joinsAt: Record<string, number> = {}, newAt: Record<string, number> = {}) {
  await fresh(s.a);
  for (const id of feeds) {
    if (id in newAt) continue;
    await add(s.a, id);
    await hold(s.a, id, [], T - HOUR);
  }
  const perDay = Object.fromEntries(feeds.map((id) => [id, Array<number>(days).fill(0)]));
  for (let hour = 0; hour < days * 24; hour++) {
    const now = T + hour * HOUR;
    for (const id of feeds) {
      if (now < T + (joinsAt[id] ?? newAt[id] ?? 0)) continue;
      if (now === T + (newAt[id] ?? -1)) await add(s.a, id);
      perDay[id]![Math.floor(hour / 24)]! += (await hold(s.a, id, unseen(id), now)).length;
    }
  }
  return perDay;
}

describe('the day of new feed photos', () => {
  it('gives each of three busy feeds its share every day, the late one too, whatever order they poll in (Fable P1)', async () => {
    const share = Math.min(NEW_PER_SOURCE_PER_DAY, NEW_PER_ORG_PER_DAY / 3);
    expect(await busy(['p1-guardian', 'p1-verge', 'p1-nyt'], 4, { 'p1-nyt': 15 * HOUR })).toEqual({
      'p1-guardian': [share, share, share, share],
      'p1-verge': [share, share, share, share],
      'p1-nyt': [share, share, share, share],
    });
  }, 120_000);

  it('makes a feed added and first shown when the day is spent wait for it to free up, then gives it its share', async () => {
    const share = NEW_PER_ORG_PER_DAY / 3;
    expect(await busy(['new-guardian', 'new-verge', 'new-nyt'], 3, {}, { 'new-nyt': 15 * HOUR })).toEqual({
      'new-guardian': [NEW_PER_SOURCE_PER_DAY, share, share],
      'new-verge': [NEW_PER_SOURCE_PER_DAY, share, share],
      'new-nyt': [0, share, share],
    });
  }, 120_000);

  it('gives each of six busy feeds its share every day', async () => {
    const feeds = Array.from({ length: 6 }, (_, i) => `p6-${i}`);
    const perDay = await busy(feeds, 3);
    const share = Math.min(NEW_PER_SOURCE_PER_DAY, Math.floor(NEW_PER_ORG_PER_DAY / 6));
    for (const id of feeds) expect(perDay[id], id).toEqual([share, share, share]);
  }, 120_000);

  it('shares the day among the feeds a screen shows: three shown beside three that are not get 20 each', async () => {
    await fresh(s.a);
    // Photos on, but no screen shows them: their polls read no photos and record none.
    for (const id of ['unshown-0', 'unshown-1', 'unshown-2']) await add(s.a, id);
    const shown = ['shown-guardian', 'shown-verge', 'shown-nyt'];
    for (const id of shown) await add(s.a, id);
    const held = Object.fromEntries(shown.map((id) => [id, 0]));
    for (let hour = 0; hour < 24; hour++) for (const id of shown) held[id]! += (await hold(s.a, id, unseen(id), T + hour * HOUR)).length;
    expect(held).toEqual(Object.fromEntries(shown.map((id) => [id, NEW_PER_ORG_PER_DAY / 3])));
  });

  it('holds the org to its day however many source ids come and go (Fable P2): 40 ids, one alive at a time', async () => {
    await fresh(s.a);
    let total = 0;
    for (let i = 0; i < 40; i++) {
      const id = `churn-${i}`;
      await add(s.a, id);
      total += (await hold(s.a, id, unseen(id), T + i * MIN)).length;
      await s.a.scope.dataSources.delete(id);
    }
    expect(total).toBe(NEW_PER_ORG_PER_DAY);
  });

  it('gives a source cut off part-way through its first poll the rest of its share on the next (Fable P4)', async () => {
    await fresh(s.a);
    for (const id of ['p4-a', 'p4-b', 'p4-part']) await add(s.a, id);
    expect(await hold(s.a, 'p4-part', unseen('p4-part', 3), T)).toHaveLength(3);
    await hold(s.a, 'p4-a', unseen('p4-a'), T);
    await hold(s.a, 'p4-b', unseen('p4-b'), T);
    expect(await hold(s.a, 'p4-part', unseen('p4-part', 7), T + HOUR)).toHaveLength(7);
  });

  it("shares only the org's own day: another org's sources and photos change nothing of it", async () => {
    await fresh(s.a);
    await fresh(s.b);
    for (let i = 0; i < 9; i++) await add(s.b, `crowd-${i}`);
    for (let i = 0; i < 6; i++) await hold(s.b, `crowd-${i}`, unseen(`crowd-${i}`), T);
    await add(s.a, 'alone');
    // Alone in its org with photos on: its share is its own cap, though org B has nine sources and a full day.
    const held = [];
    for (let k = 0; k < 4; k++) held.push(...(await hold(s.a, 'alone', unseen('alone'), T + k * HOUR)));
    expect(held).toHaveLength(NEW_PER_SOURCE_PER_DAY);
  });

  it("reads the org's rows once: the hold scans them once, its sources' few beside (Fable P6)", async () => {
    await fresh(s.a);
    await add(s.a, 'p6-reader');
    await add(s.a, 'p6-other');
    const old = T - 3 * DAY;
    for (let i = 0; i < 400; i += 50) {
      const values = Array.from({ length: 50 }, (_, k) => `('org-a','https://p6.example/old-${T}-${i + k}.jpg','p6-other',${old},${old},${old})`).join(',');
      await env.DB.exec(`INSERT INTO feed_images (org_id,url,source_id,next_check_at,created_at,updated_at) VALUES ${values}`);
    }
    const rows = (await env.DB.prepare("SELECT count(*) AS n FROM feed_images WHERE org_id = 'org-a'").first<{ n: number }>())!.n;
    const sources = (await env.DB.prepare("SELECT count(*) AS n FROM data_sources WHERE org_id = 'org-a'").first<{ n: number }>())!.n;
    const read: number[] = [];
    const batch = env.DB.batch.bind(env.DB);
    env.DB.batch = async <T = unknown>(q: D1PreparedStatement[]) => {
      const res = await batch<T>(q);
      for (const r of res) read.push(r.meta.rows_read);
      return res;
    };
    try {
      await hold(s.a, 'p6-reader', ['https://p6.example/new.jpg'], T);
    } finally {
      env.DB.batch = batch;
    }
    // The most any statement of the save reads: the hold, once over the org's photo rows, with its sources and lookups.
    expect(Math.max(...read)).toBeLessThanOrEqual(rows + sources + 10);
  });
});
