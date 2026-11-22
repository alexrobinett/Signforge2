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

    const claimed = await claimDueDataSources(env.DB, NOW, { limit: 10, leaseMs: 60_000, backoffMaxMs: 6 * 3_600_000 });
    const mine = claimed.filter((c) => c.orgId.startsWith('org-poll-')).sort((x, y) => x.orgId.localeCompare(y.orgId));
    expect(mine).toEqual([
      { orgId: 'org-poll-a', id: a.dataSource },
      { orgId: 'org-poll-b', id: b.dataSource },
    ]);
    // Held for the backoff a failure would get, 300 s doubled once, so a run that dies cannot retry it every lease.
    expect(await a.scope.dataSources.get(a.dataSource)).toMatchObject({ nextPollAt: NOW + 600_000 });
    expect(await a.scope.dataSources.get(late.id)).toMatchObject({ nextPollAt: NOW + 1 });
    // Claimed: a second run in the same minute does not fetch them again.
    expect(
      (await claimDueDataSources(env.DB, NOW, { limit: 10, leaseMs: 60_000, backoffMaxMs: 6 * 3_600_000 })).filter((c) => c.orgId.startsWith('org-poll-')),
    ).toEqual([]);
  });

  it('holds a failing source for its next backoff, at most the cap, and at least the lease', async () => {
    const claim = async (failures: number, refreshS: number, leaseMs = 60_000) => {
      await a.scope.dataSources.update(a.dataSource, { nextPollAt: NOW - 1, failures, refreshS });
      await b.scope.dataSources.update(b.dataSource, { nextPollAt: NOW + 1 });
      await claimDueDataSources(env.DB, NOW, { limit: 10, leaseMs, backoffMaxMs: 6 * 3_600_000 });
      return ((await a.scope.dataSources.get(a.dataSource))?.nextPollAt ?? 0) - NOW;
    };
    expect(await claim(2, 300)).toBe(300_000 * 8);
    expect(await claim(9, 300)).toBe(6 * 3_600_000);
    expect(await claim(60, 86_400)).toBe(6 * 3_600_000);
    expect(await claim(0, 300, 20 * 60_000)).toBe(20 * 60_000);
  });

  it('claims at most the limit, the longest due first', async () => {
    await a.scope.dataSources.update(a.dataSource, { nextPollAt: 2 });
    await b.scope.dataSources.update(b.dataSource, { nextPollAt: 1 });
    expect(await claimDueDataSources(env.DB, NOW, { limit: 1, leaseMs: 60_000, backoffMaxMs: 6 * 3_600_000 })).toEqual([
      { orgId: 'org-poll-b', id: b.dataSource },
    ]);
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
    // Without the data: what a list of sources needs.
    expect(await o.dataSources.checkedTimes([a.dataSource])).toEqual([{ dataSourceId: a.dataSource, checkedAt: NOW + 300_000 }]);
  });

  it("leaves the source's version alone, so a person's edit made meanwhile is not stale", async () => {
    const o = a.scope;
    const before = (await o.dataSources.get(a.dataSource))!;
    await o.dataSources.savePoll(a.dataSource, { source: { nextPollAt: NOW + 900_000, failures: 1, lastError: 'timeout' } });
    expect(await o.dataSources.get(a.dataSource)).toMatchObject({ nextPollAt: NOW + 900_000, failures: 1, rowVersion: before.rowVersion });
  });
});

describe('storing a feed photo', () => {
  it("drops the source's validators in its own org only, leaving its schedule, failures and version", async () => {
    const url = 'https://photo.example/test.jpg';
    const hash = 'a'.repeat(64);
    const photoUrlsJson = JSON.stringify([url]);
    await a.scope.dataSources.update(a.dataSource, { format: 'rss', etag: '"a"', lastModified: 'Mon', nextPollAt: NOW + 5, failures: 2 });
    await b.scope.dataSources.update(b.dataSource, { format: 'rss', etag: '"b"', lastModified: 'Tue', photoUrlsJson });
    const before = (await a.scope.dataSources.get(a.dataSource))!;
    await a.scope.feedImages.hold([url], { until: NOW + 1, now: NOW, sourceId: a.dataSource });
    await a.scope.feedImages.save(url, { fileSha256: hash, thumbSha256: hash, nextCheckAt: NOW + 20 }, { sourceId: a.dataSource, now: NOW });
    expect(await a.scope.dataSources.get(a.dataSource)).toMatchObject({
      etag: null,
      lastModified: null,
      nextPollAt: NOW + 5,
      failures: 2,
      rowVersion: before.rowVersion,
      photoGeneration: before.photoGeneration + 1,
    });
    expect(await b.scope.dataSources.get(b.dataSource)).toMatchObject({ etag: '"b"', lastModified: 'Tue' });
  });
});

describe('dataSources.stage.deleteUnbound', () => {
  it('deletes, with its snapshot, each source made before a time that no spot binds in its draft or its published version, checked when the batch runs', async () => {
    const o = await seedOrg(env.DB, 'org-unbound');
    const org = o.scope;
    const source = (id: string) => org.dataSources.insert({ id, name: id, format: 'json', urlEncrypted: `enc:${id}`, refreshS: 300 });
    const bind = (id: string) => JSON.stringify({ title: { source: id, path: 'title' } });
    for (const id of ['ub-draft', 'ub-published', 'ub-free', 'ub-late']) {
      await source(id);
      await env.DB.prepare('UPDATE data_sources SET created_at = ? WHERE id = ?')
        .bind(Date.now() - 3_600_000, id)
        .run();
    }
    // Made just now: kept, bound or not, until it is older than `madeBefore`.
    await source('ub-new');
    await org.dataSources.putSnapshot('ub-free', { version: 'v1', fetchedAt: NOW, checkedAt: NOW, dataJson: '{}' });
    // Published bound to ub-published, then the draft moved to ub-draft.
    await org.spots.update(o.templateSpot, { bindingsJson: bind('ub-published') });
    await org.commit(org.spots.stage.publish((await org.spots.get(o.templateSpot))!).writes);
    await org.spots.update(o.templateSpot, { bindingsJson: bind('ub-draft') });

    const cleanup = org.dataSources.stage.deleteUnbound(['ub-draft', 'ub-published', 'ub-free', 'ub-late', 'ub-new', b.dataSource], Date.now() - 60_000);
    // Bound between the look and the commit: it stays.
    await org.spots.update(o.imageSpot, { bindingsJson: bind('ub-late') });
    await org.commit(cleanup.writes);

    const left = new Set((await org.dataSources.list()).map((d) => d.id));
    expect(['ub-draft', 'ub-published', 'ub-late', 'ub-new'].every((id) => left.has(id))).toBe(true);
    expect(left.has('ub-free')).toBe(false);
    expect(await org.dataSources.snapshot('ub-free')).toBeUndefined();
    // Another org's id deletes nothing of theirs.
    expect(await b.scope.dataSources.get(b.dataSource)).toBeDefined();
  });
});
