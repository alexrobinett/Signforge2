// count_drafts (#361): one SQL count per kind of the drafts screens do not have yet, for the
// sidebar's badges, never reading every row. Counted by version, not time: the file's clock stands
// still, so a publish and the edit after it share a millisecond and the edit still counts.
import { seedOrg, testScope } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dispatch, registry } from '../src';
import { editorCalls, ok } from './calls';
import { memberOf } from './member';

beforeAll(() => vi.setSystemTime('2026-11-24T12:00:00Z'));
afterAll(() => vi.useRealTimers());

describe('count_drafts', () => {
  it('counts the drafts never published or edited since, by kind; a publish clears them, an edit in its millisecond counts again', async () => {
    const o = await seedOrg(env.DB, 'count-drafts');
    const call = editorCalls(testScope(env.DB, o.orgId));
    expect(await ok(call('count_drafts', {}))).toEqual({ spots: 2, playlists: 1, scheduleEntries: 1 });
    await ok(call('publish', {}));
    expect(await ok(call('count_drafts', {}))).toEqual({ spots: 0, playlists: 0, scheduleEntries: 0 });
    await ok(call('update_spot', { spotId: o.imageSpot, durationMs: 9_000 }));
    expect(await ok(call('count_drafts', {}))).toEqual({ spots: 1, playlists: 0, scheduleEntries: 0 });
  });

  it('is a viewer’s to read, and counts only its own org', async () => {
    const mine = await seedOrg(env.DB, 'count-drafts-mine');
    const other = await seedOrg(env.DB, 'count-drafts-other');
    // The other org's drafts, all published: they must not count here, nor this org's there.
    await ok(editorCalls(testScope(env.DB, other.orgId))('publish', {}));
    const viewer = memberOf(testScope(env.DB, mine.orgId), 'viewer');
    expect(await dispatch(registry, 'count_drafts', {}, viewer)).toMatchObject({ ok: true, output: { spots: 2, playlists: 1, scheduleEntries: 1 } });
    const there = memberOf(testScope(env.DB, other.orgId), 'viewer');
    expect(await dispatch(registry, 'count_drafts', {}, there)).toMatchObject({ ok: true, output: { spots: 0, playlists: 0, scheduleEntries: 0 } });
  });
});
