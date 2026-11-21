import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { LABEL_LIMITS } from '../src/index';
import { seedOrg, testScope, type SeededOrg, type TestScope } from '../src/testing';

let o: SeededOrg;
let org: TestScope;
beforeAll(async () => {
  o = await seedOrg(env.DB, 'labels-org');
  org = testScope(env.DB, o.orgId);
});

const update = async (screenIds: string[], set: Record<string, string>, remove: string[] = []) =>
  org.commit((await org.screens.labels.stage.update(screenIds, { set, remove })).writes);

describe('screens.labels', () => {
  it('merges: a set key takes its value, a removed key goes, the rest stay', async () => {
    const other = await org.screens.insert({ name: 'Bar', timezone: 'Europe/London', orientation: 'portrait' });
    await update([o.screen, other.id], { type: 'kiosk', store: '0142' });
    await update([o.screen], { type: 'Drive-Thru' }, ['store', 'never-set']);
    expect(await org.screens.labels.list()).toEqual(
      [
        { screenId: o.screen, key: 'region', value: o.orgId },
        { screenId: o.screen, key: 'type', value: 'Drive-Thru' },
        { screenId: other.id, key: 'store', value: '0142' },
        { screenId: other.id, key: 'type', value: 'kiosk' },
      ].toSorted((a, b) => a.screenId.localeCompare(b.screenId)),
    );
    expect(await org.screens.labels.list(other.id)).toHaveLength(2);
    // A screen's labels go with it.
    await org.screens.delete(other.id);
    expect(await org.screens.labels.list(other.id)).toEqual([]);
  });

  it('fails the batch past a limit, though each change was checked alone', async () => {
    const free = LABEL_LIMITS.perScreen - (await org.screens.labels.list(o.screen)).length;
    const keys = (from: number, n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${from + i}`, 'v']));
    // Two changes, each within the limit from the same read, committed together as racing calls would land.
    const first = await org.screens.labels.stage.update([o.screen], { set: keys(0, free), remove: [] });
    const second = await org.screens.labels.stage.update([o.screen], { set: keys(free, 1), remove: [] });
    await org.commit(first.writes);
    const before = await org.screens.labels.list(o.screen);
    expect(before).toHaveLength(LABEL_LIMITS.perScreen);
    await expect(org.commit(second.writes)).rejects.toThrow();
    expect(await org.screens.labels.list(o.screen)).toEqual(before);
  });
});
