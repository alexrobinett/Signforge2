// Smart groups (#186): a group defined by a selector. save_group takes its rule, list_groups computes its screens,
// membership changes are refused while it is a rule, removing a key its rule names is said, and a takeover reaches
// the screens it matches when sent, held to them by its card's reach. The publish's resolution: publishing.test.ts.
// Each call's idempotency key is its own: the run's database keeps a key's first answer.
import { seedOrg, seedTeam, testScope, type SeededOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dispatch, registry, type Caller } from '../src';
import { fakeServices } from './services';

const START = Date.UTC(2100, 0, 5, 9);
let o: SeededOrg;
let owner: Caller;
let till: { id: string };

const run = (name: string, input: unknown) => dispatch(registry, name, input, owner);
const call = async <T = any>(name: string, input: unknown): Promise<T> => {
  const r = await run(name, input);
  if (!r.ok) throw new Error(`${name}: ${r.error}: ${r.message}`);
  return r.output as T;
};
const scope = () => testScope(env.DB, o.orgId);
const north = { all: [{ key: 'region', op: 'eq', values: ['North'] }] };

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  o = await seedOrg(env.DB, 'smart-groups');
  await seedTeam(env.DB, o.orgId);
  owner = { org: scope(), role: 'owner', actor: { kind: 'user', id: `${o.orgId}-owner`, clientId: 'cms' }, blobs: env.BLOBS, services: fakeServices };
  till = await scope().screens.insert({ name: 'Till', timezone: 'Europe/London', orientation: 'landscape' });
  // What a takeover's publish needs: a default playlist for its screens.
  await scope().commit((await scope().settings.stage.set({ defaultPlaylistId: o.playlist })).writes);
  await call('update_screen_labels', { screenIds: [o.screen], set: { region: 'north' } });
  await call('update_screen_labels', { screenIds: [till.id], set: { region: 'south' } });
});
afterAll(() => vi.useRealTimers());

describe('a smart group through the tools', () => {
  it('is made from a selector, and lists the screens it matches now, matched as selectors match', async () => {
    const { group } = await call('save_group', { name: 'North', selector: north, idempotencyKey: crypto.randomUUID() });
    expect(group).toMatchObject({ selector: north, screenIds: [o.screen] });
    const listed = (await call('list_groups', {})).groups.find((g: { id: string }) => g.id === group.id);
    expect(listed).toMatchObject({ selector: north, screenIds: [o.screen] });
  });

  it('refuses a membership change while it is a rule, and lists screens again once its rule is null', async () => {
    const { group } = await call('save_group', { name: 'North again', selector: north, idempotencyKey: crypto.randomUUID() });
    const refused = await run('save_group', { groupId: group.id, screenIds: [o.screen], membership: 'add' });
    expect(refused).toMatchObject({ ok: false, error: 'conflict' });
    expect(refused.ok ? '' : refused.message).toMatch(/defined by a rule/);
    const listed = await call('save_group', { groupId: group.id, selector: null, ifVersion: group.version });
    expect(listed.group).toMatchObject({ selector: null, screenIds: [] });
    expect((await call('save_group', { groupId: group.id, screenIds: [o.screen], membership: 'add' })).group.screenIds).toEqual([o.screen]);
  });

  it('turns a list into a rule, its listed rows gone, so none stands if it is made a list again', async () => {
    const before = (await call('list_groups', {})).groups.find((g: { id: string }) => g.id === o.group);
    expect(before.screenIds).toEqual([o.screen]);
    const ruled = await call('save_group', {
      groupId: o.group,
      selector: { all: [{ key: 'region', op: 'eq', values: ['south'] }] },
      ifVersion: before.version,
    });
    expect(ruled.group.screenIds).not.toContain(o.screen);
    expect(await scope().screenGroups.members(o.group)).toEqual([]);
    const listed = await call('save_group', { groupId: o.group, selector: null, ifVersion: ruled.group.version });
    expect(listed.group.screenIds).toEqual([]);
  });

  it("is among a screen's groups as get_screen reads them (review of #608)", async () => {
    const { group } = await call('save_group', { name: 'North screen', selector: north, idempotencyKey: crypto.randomUUID() });
    expect((await call('get_screen', { screenId: o.screen })).groupIds).toContain(group.id);
    expect((await call('get_screen', { screenId: till.id })).groupIds).not.toContain(group.id);
  });

  it('refuses an empty rule, which would be every screen (review of #608)', async () => {
    expect(await run('save_group', { name: 'Everything', selector: { all: [] } })).toMatchObject({ ok: false, error: 'invalid_input' });
  });

  it('refuses a selector beside screenIds, and one past the ten terms a rule may have', async () => {
    const both = await run('save_group', { name: 'Both', selector: north, screenIds: [o.screen] });
    expect(both).toMatchObject({ ok: false, error: 'invalid_input' });
    const terms = Array.from({ length: 11 }, (_, i) => ({ key: `k${i}`, op: 'exists' }));
    expect(await run('save_group', { name: 'Long', selector: { all: terms } })).toMatchObject({ ok: false, error: 'invalid_input' });
  });

  it('names the smart groups whose rule a removed key is in, and still removes it', async () => {
    const { group } = await call('save_group', { name: 'Has store', selector: { all: [{ key: 'store', op: 'exists' }] }, idempotencyKey: crypto.randomUUID() });
    await call('update_screen_labels', { screenIds: [o.screen], set: { store: '0142' } });
    const out = await call('update_screen_labels', { screenIds: [o.screen], remove: ['store'] });
    expect(out.groupsUsingRemoved).toEqual([{ id: group.id, name: 'Has store' }]);
    expect(out.screens[0].labels.store).toBeUndefined();
  });
});

describe('a takeover of a smart group (owner decision on #179)', () => {
  it('reaches the screens its rule matches when sent, and is refused when the card showed others', async () => {
    const { group } = await call('save_group', { name: 'North takeover', selector: north, idempotencyKey: crypto.randomUUID() });
    await call('publish', {});
    const endsAt = new Date(START + 3_600_000).toISOString();
    const sent = await call('takeover', { action: 'publish', playlistId: o.playlist, target: 'group', groupId: group.id, endsAt, ifReach: [o.screen] });
    expect(sent.entry).toMatchObject({ target: 'group', groupId: group.id });
    // Reached: the screen its rule matches gets the takeover, the one it does not keeps what it plays (#186's done when).
    const outcome = (id: string) => sent.screens.find((x: { screenId: string }) => x.screenId === id)?.outcome;
    expect(outcome(o.screen)).toBe('updated');
    expect(outcome(till.id)).toBe('unchanged');

    // Another screen labelled into the group after the card was shown: the press is refused, naming the screens now.
    const lobby2 = await scope().screens.insert({ name: 'Lobby 2', timezone: 'Europe/London', orientation: 'landscape' });
    await call('update_screen_labels', { screenIds: [lobby2.id], set: { region: 'NORTH' } });
    const stale = await run('takeover', { action: 'publish', playlistId: o.playlist, target: 'group', groupId: group.id, endsAt, ifReach: [o.screen] });
    expect(stale).toMatchObject({ ok: false, error: 'conflict', details: { screens: [o.screen, lobby2.id].toSorted() } });
  });

  it('is refused when a screen a missing term matches is claimed between its reads and its write (review of #608)', async () => {
    const { group } = await call('save_group', { name: 'No zone', selector: { all: [{ key: 'zone', op: 'missing' }] }, idempotencyKey: crypto.randomUUID() });
    // A new screen has no labels, so a rule of missing terms takes it in: the guard compares the screens too.
    const raced = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            await scope().screens.insert({ name: 'Claimed meanwhile', timezone: 'Europe/London', orientation: 'landscape' });
            return target.batch(statements);
          };
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const endsAt = new Date(START + 3_600_000).toISOString();
    const input = { action: 'publish', playlistId: o.playlist, target: 'group', groupId: group.id, endsAt, ifReach: group.screenIds };
    const out = await dispatch(registry, 'takeover', input, { ...owner, org: testScope(raced, o.orgId) });
    expect(out).toMatchObject({ ok: false, error: 'conflict' });
  });
});
