import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { claimDueDataSources } from '../src/index';
import { seedOrg, type SeededOrg } from '../src/testing';

let a: SeededOrg;
let b: SeededOrg;
beforeAll(async () => {
  a = await seedOrg(env.DB, 'org-poll-a');
  b = await seedOrg(env.DB, 'org-poll-b');
});

const NOW = 1_800_000_000_000;

describe('claimDueDataSources', () => {
  it('claims the sources due in every org and holds them for the lease', async () => {
    await a.scope.dataSources.update(a.dataSource, { nextPollAt: NOW - 10 });
    await b.scope.dataSources.update(b.dataSource, { nextPollAt: NOW - 20 });
    const late = await a.scope.dataSources.insert({ id: 'later', name: 'Later', format: 'rss', urlEncrypted: 'enc:l', refreshS: 300, nextPollAt: NOW + 1 });

    const claimed = await claimDueDataSources(env.DB, NOW, { limit: 10, leaseMs: 60_000 });
    const mine = claimed.filter((c) => c.orgId.startsWith('org-poll-')).sort((x, y) => x.orgId.localeCompare(y.orgId));
    expect(mine).toEqual([
      { orgId: 'org-poll-a', id: a.dataSource },
      { orgId: 'org-poll-b', id: b.dataSource },
    ]);
    expect(await a.scope.dataSources.get(a.dataSource)).toMatchObject({ nextPollAt: NOW + 60_000 });
    expect(await a.scope.dataSources.get(late.id)).toMatchObject({ nextPollAt: NOW + 1 });
    // Claimed: a second run in the same minute does not fetch them again.
    expect((await claimDueDataSources(env.DB, NOW, { limit: 10, leaseMs: 60_000 })).filter((c) => c.orgId.startsWith('org-poll-'))).toEqual([]);
  });

  it('claims at most the limit, the longest due first', async () => {
    await a.scope.dataSources.update(a.dataSource, { nextPollAt: 2 });
    await b.scope.dataSources.update(b.dataSource, { nextPollAt: 1 });
    expect(await claimDueDataSources(env.DB, NOW, { limit: 1, leaseMs: 60_000 })).toEqual([{ orgId: 'org-poll-b', id: b.dataSource }]);
  });
});

describe('a poll saved', () => {
  it('writes a changed snapshot with the source, and an unchanged one only moves checkedAt', async () => {
    const o = a.scope;
    await o.dataSources.savePoll(a.dataSource, {
      source: { nextPollAt: NOW + 300_000, failures: 0, lastError: null, etag: '"e1"' },
      snapshot: { version: 'h2', fetchedAt: NOW, checkedAt: NOW, dataJson: '{"t":13}' },
    });
    expect(await o.dataSources.get(a.dataSource)).toMatchObject({ nextPollAt: NOW + 300_000, etag: '"e1"' });
    expect(await o.dataSources.snapshots([a.dataSource])).toEqual([
      { dataSourceId: a.dataSource, version: 'h2', fetchedAt: NOW, checkedAt: NOW, dataJson: '{"t":13}' },
    ]);

    await o.dataSources.savePoll(a.dataSource, { source: { nextPollAt: NOW + 600_000 }, checkedAt: NOW + 300_000 });
    expect(await o.dataSources.snapshots([a.dataSource])).toEqual([
      { dataSourceId: a.dataSource, version: 'h2', fetchedAt: NOW, checkedAt: NOW + 300_000, dataJson: '{"t":13}' },
    ]);
  });

  it("leaves the source's version alone, so a person's edit made meanwhile is not stale", async () => {
    const o = a.scope;
    const before = (await o.dataSources.get(a.dataSource))!;
    await o.dataSources.savePoll(a.dataSource, { source: { nextPollAt: NOW + 900_000, failures: 1, lastError: 'timeout' } });
    expect(await o.dataSources.get(a.dataSource)).toMatchObject({ nextPollAt: NOW + 900_000, failures: 1, rowVersion: before.rowVersion });
  });
});
