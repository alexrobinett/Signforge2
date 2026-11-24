// count_drafts (#361): one SQL count per kind of the drafts screens do not have yet, for the
// sidebar's badges, never reading every row.
import { seedOrg, testScope } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { editorCalls, ok } from './calls';

describe('count_drafts', () => {
  it('counts the drafts never published or edited since, by kind; a publish clears them, an edit counts again', async () => {
    const o = await seedOrg(env.DB, 'count-drafts');
    const call = editorCalls(testScope(env.DB, o.orgId));
    const before = await ok(call('count_drafts', {}));
    expect(before).toEqual({ spots: 2, playlists: 1, scheduleEntries: 1 });
    await ok(call('publish', {}));
    expect(await ok(call('count_drafts', {}))).toEqual({ spots: 0, playlists: 0, scheduleEntries: 0 });
    await ok(call('update_spot', { spotId: o.imageSpot, durationMs: 9_000 }));
    expect(await ok(call('count_drafts', {}))).toEqual({ spots: 1, playlists: 0, scheduleEntries: 0 });
  });
});
