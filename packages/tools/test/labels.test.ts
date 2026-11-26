// Screen labels: update_screen_labels, list_label_keys, labels on list_screens and get_screen, list_screens({ selector }) and claim_screen's labels.
import { LABEL_LIMITS, startPairing } from '@signforge/db';
import { seedOrg, testScope, type SeededOrg, type TestScope } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dispatch, registry, type Caller } from '../src';
import { member } from './member';

const NOW = Date.parse('2026-11-21T12:00:00Z');

let o: SeededOrg;
let org: TestScope;
let editor: Caller;

const run = (name: string, input: unknown, caller = editor) => dispatch(registry, name, input, caller);
const call = async <T = any>(name: string, input: unknown, caller = editor): Promise<T> => {
  const r = await run(name, input, caller);
  if (!r.ok) throw new Error(`${name}: ${r.error}: ${r.message}`);
  return r.output as T;
};
const newScreen = (name: string, orientation: 'landscape' | 'portrait' = 'landscape') => org.screens.insert({ name, timezone: 'Europe/London', orientation });
const labelsOf = async (screenId: string) => (await call('get_screen', { screenId })).screen.labels;
const picked = async (selector: unknown) => (await call('list_screens', { selector, limit: 200 })).screens.map((s: { name: string }) => s.name).toSorted();

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  o = await seedOrg(env.DB, 'labels-tools');
  org = testScope(env.DB, o.orgId);
  editor = member(o.orgId, 'editor');
});
afterAll(() => vi.useRealTimers());

describe('update_screen_labels', () => {
  it('merges: a set key takes its value, a removed key goes, the rest stay', async () => {
    const a = await newScreen('Merge A');
    const b = await newScreen('Merge B');
    expect(await call('update_screen_labels', { screenIds: [b.id, a.id, a.id], set: { type: 'kiosk', store: '0142' } })).toEqual({
      screens: [a.id, b.id].toSorted().map((id) => ({ id, labels: { type: 'kiosk', store: '0142' } })),
      groupsUsingRemoved: [],
    });
    // Stored as typed, trimmed; a key a screen lacks is ignored on removal.
    expect(await call('update_screen_labels', { screenIds: [a.id], set: { type: '  Drive-Thru ' }, remove: ['store', 'legacy'] })).toEqual({
      screens: [{ id: a.id, labels: { type: 'Drive-Thru' } }],
      groupsUsingRemoved: [],
    });
    expect(await labelsOf(a.id)).toEqual({ type: 'Drive-Thru' });
    expect(await labelsOf(b.id)).toEqual({ type: 'kiosk', store: '0142' });
  });

  it('is audited, on the screen when there is one', async () => {
    const a = await newScreen('Audited');
    await call('update_screen_labels', { screenIds: [a.id], set: { region: 'north' } });
    expect((await call('get_screen', { screenId: a.id })).events).toEqual([
      expect.objectContaining({ action: 'update_screen_labels', input: { screenIds: [a.id], set: { region: 'north' }, remove: [] } }),
    ]);
  });

  it('needs something to change, and a key set or removed, not both', async () => {
    expect(await run('update_screen_labels', { screenIds: [o.screen] })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await run('update_screen_labels', { screenIds: [o.screen], set: { region: 'x' }, remove: ['region'] })).toMatchObject({
      ok: false,
      error: 'invalid_input',
    });
  });

  it('takes at most 1000 screens, and is for editors', async () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `scr_${String(i).padStart(4, '0')}`);
    expect(await run('update_screen_labels', { screenIds: ids, set: { a: 'b' } })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await run('update_screen_labels', { screenIds: [o.screen], set: { a: 'b' } }, member(o.orgId, 'viewer'))).toMatchObject({
      ok: false,
      error: 'forbidden',
    });
  });

  it('checks keys: 1 to 63 lowercase letters, digits, - _ ., a letter or digit at each end', async () => {
    for (const key of ['region', 'a', 'store.no', 'drive_thru-2', 'x'.repeat(63)])
      expect((await run('update_screen_labels', { screenIds: [o.screen], set: { [key]: 'v' } })).ok, key).toBe(true);
    for (const key of ['', 'Region', 'x'.repeat(64), '-a', 'a-', '.a', 'a b', 'région', 'a/b'])
      expect(await run('update_screen_labels', { screenIds: [o.screen], set: { [key]: 'v' } }), key).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await run('update_screen_labels', { screenIds: [o.screen], remove: ['Region'] })).toMatchObject({ ok: false, error: 'invalid_input' });
  });

  it('checks values: 1 to 63 characters once trimmed, printable, spaces allowed, well-formed Unicode', async () => {
    for (const value of ['North Side', 'Ünïcödé 店', '😀', 'x'.repeat(63), ` ${'x'.repeat(63)} `])
      expect((await run('update_screen_labels', { screenIds: [o.screen], set: { v: value } })).ok, value).toBe(true);
    for (const value of ['', '   ', 'x'.repeat(64), 'a\nb', 'a\tb', 'a\u0000b', 'a b', '\uD800', '\uDC00', 'a\uD800b', '\uDC00\uD800'])
      expect(await run('update_screen_labels', { screenIds: [o.screen], set: { v: value } }), JSON.stringify(value)).toMatchObject({
        ok: false,
        error: 'invalid_input',
      });
  });

  it('refuses a dropped __proto__ key and lone surrogates without writing any label', async () => {
    const s = await newScreen('No partial write');
    const withProto = JSON.parse('{"region":"North","__proto__":"invalid"}');
    expect(await run('update_screen_labels', { screenIds: [s.id], set: withProto })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await labelsOf(s.id)).toEqual({});
    expect(await run('update_screen_labels', { screenIds: [s.id], set: { region: '\uD800' } })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await labelsOf(s.id)).toEqual({});
  });

  it('refuses reserved keys: system labels, name, id, status and sf.', async () => {
    for (const key of ['orientation', 'kind', 'timezone', 'locale', 'name', 'id', 'status', 'sf.anything']) {
      expect(await run('update_screen_labels', { screenIds: [o.screen], set: { [key]: 'v' } }), key).toMatchObject({ ok: false, error: 'invalid_input' });
      expect(await run('update_screen_labels', { screenIds: [o.screen], remove: [key] }), key).toMatchObject({ ok: false, error: 'invalid_input' });
    }
    expect(await run('update_screen_labels', { screenIds: [o.screen], set: { orientation: 'portrait' } })).toMatchObject({
      message: expect.stringContaining('update_screen'),
    });
  });

  it(`gives a screen at most ${LABEL_LIMITS.perScreen} labels`, async () => {
    const s = await newScreen('Crowded');
    const keys = (from: number, n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${from + i}`, 'v']));
    await call('update_screen_labels', { screenIds: [s.id], set: keys(0, LABEL_LIMITS.perScreen - 1) });
    expect(await run('update_screen_labels', { screenIds: [s.id, o.screen], set: keys(100, 2) })).toMatchObject({
      ok: false,
      error: 'conflict',
      details: { screenIds: [s.id] },
    });
    expect(await labelsOf(s.id)).toEqual(keys(0, LABEL_LIMITS.perScreen - 1));
    // Removing makes room in the same call; setting a key it has again takes none.
    await call('update_screen_labels', { screenIds: [s.id], set: { ...keys(100, 2), c0: 'w' }, remove: ['c1'] });
    expect(Object.keys(await labelsOf(s.id))).toHaveLength(LABEL_LIMITS.perScreen);
    for (const c of [s.id]) await call('update_screen_labels', { screenIds: [c], remove: Object.keys(await labelsOf(c)) });
  });
});

describe('the org', () => {
  it(`has at most ${LABEL_LIMITS.keys} label keys between its screens`, async () => {
    const own = await seedOrg(env.DB, 'labels-keys');
    const scope = testScope(env.DB, own.orgId);
    const as = member(own.orgId, 'editor');
    // The seeded screen has `region`: one key.
    const used = 1;
    const room = LABEL_LIMITS.keys - used;
    let n = 0;
    for (let left = room; left > 0; ) {
      const s = await scope.screens.insert({ name: `Keys ${n}`, timezone: 'Europe/London', orientation: 'landscape' });
      const take = Math.min(left, LABEL_LIMITS.perScreen);
      const set = Object.fromEntries(Array.from({ length: take }, (_, i) => [`k${n + i}`, 'v']));
      expect((await run('update_screen_labels', { screenIds: [s.id], set }, as)).ok).toBe(true);
      n += take;
      left -= take;
    }
    expect(await run('update_screen_labels', { screenIds: [own.screen], set: { another: 'v' } }, as)).toMatchObject({ ok: false, error: 'conflict' });
    // A key in use takes no room, and one removed from its last screen gives some back.
    expect((await run('update_screen_labels', { screenIds: [own.screen], set: { k0: 'v' } }, as)).ok).toBe(true);
    const last = (await scope.screens.labels.list()).find((l) => l.key === `k${n - 1}`)!;
    expect((await run('update_screen_labels', { screenIds: [last.screenId], set: { another: 'v' }, remove: [last.key] }, as)).ok).toBe(true);
    // A claim's labels count too.
    await startPairing(env.DB, { code: 'LBL234', pollTokenHash: 'b'.repeat(64), now: NOW });
    expect(
      await run('claim_screen', { code: 'LBL234', name: 'New', timezone: 'Europe/London', orientation: 'portrait', labels: { brand: 'new' } }, as),
    ).toMatchObject({ ok: false, error: 'conflict' });
  });

  it("keeps each org's labels to itself", async () => {
    const theirs = await seedOrg(env.DB, 'labels-theirs');
    const before = await testScope(env.DB, theirs.orgId).screens.labels.list();
    expect(await run('update_screen_labels', { screenIds: [o.screen, theirs.screen], set: { region: 'hijacked' } })).toMatchObject({
      ok: false,
      error: 'not_found',
    });
    expect(await run('update_screen_labels', { screenIds: [theirs.screen], remove: ['region'] })).toMatchObject({ ok: false, error: 'not_found' });
    expect(await testScope(env.DB, theirs.orgId).screens.labels.list()).toEqual(before);
    expect(await labelsOf(o.screen)).not.toHaveProperty('region', 'hijacked');
    // Nothing of theirs is listed: not their key's value, nor their screen.
    const keys = (await call('list_label_keys', { limit: 200 })).keys;
    expect(keys.find((k: { key: string }) => k.key === 'region').values).not.toContainEqual(expect.objectContaining({ value: theirs.orgId }));
    expect((await call('list_screens', { selector: { all: [{ key: 'region', op: 'eq', values: [theirs.orgId] }] } })).screens).toEqual([]);
  });
});

describe('list_screens and get_screen', () => {
  it('return labels, and system labels from the settings, marked as such', async () => {
    const s = await org.screens.insert({ name: 'Shown', timezone: 'America/Chicago', orientation: 'portrait', locale: 'en-US' });
    await call('update_screen_labels', { screenIds: [s.id], set: { region: 'South' } });
    const shown = { labels: { region: 'South' }, systemLabels: { orientation: 'portrait', kind: 'device', timezone: 'America/Chicago', locale: 'en-US' } };
    expect((await call('get_screen', { screenId: s.id })).screen).toMatchObject(shown);
    expect((await call('list_screens', { limit: 200 })).screens.find((v: { id: string }) => v.id === s.id)).toMatchObject(shown);
  });
});

describe('list_screens({ selector })', () => {
  beforeAll(async () => {
    const [north, northKiosk, south, portrait] = await Promise.all([
      newScreen('Sel north drive-thru'),
      newScreen('Sel north kiosk'),
      newScreen('Sel south drive-thru'),
      newScreen('Sel portrait', 'portrait'),
    ]);
    await call('update_screen_labels', { screenIds: [north.id, south.id], set: { sel: 'yes', type: 'Drive-Thru' } });
    await call('update_screen_labels', { screenIds: [north.id, northKiosk.id], set: { region: 'North' } });
    await call('update_screen_labels', { screenIds: [northKiosk.id, portrait.id], set: { sel: 'yes', type: 'kiosk' } });
    await call('update_screen_labels', { screenIds: [south.id], set: { region: 'south' } });
  });
  const sel = { key: 'sel', op: 'eq', values: ['yes'] };

  it('picks the north drive-thru screens, values matched case-insensitively', async () => {
    expect(
      await picked({
        all: [
          { key: 'region', op: 'eq', values: ['north'] },
          { key: 'type', op: 'eq', values: ['DRIVE-THRU'] },
        ],
      }),
    ).toEqual(['Sel north drive-thru']);
    expect(await picked({ all: [sel, { key: 'type', op: 'in', values: ['drive-thru', 'KIOSK'] }] })).toEqual([
      'Sel north drive-thru',
      'Sel north kiosk',
      'Sel portrait',
      'Sel south drive-thru',
    ]);
  });

  it('matches orientation=portrait though no one typed it', async () => {
    expect(await picked({ all: [sel, { key: 'orientation', op: 'eq', values: ['portrait'] }] })).toEqual(['Sel portrait']);
    expect(await picked({ all: [sel, { key: 'orientation', op: 'neq', values: ['Portrait'] }] })).toEqual([
      'Sel north drive-thru',
      'Sel north kiosk',
      'Sel south drive-thru',
    ]);
  });

  it('never matches a missing key with != or notin', async () => {
    expect(await picked({ all: [sel, { key: 'region', op: 'neq', values: ['north'] }] })).toEqual(['Sel south drive-thru']);
    expect(await picked({ all: [sel, { key: 'region', op: 'notin', values: ['south'] }] })).toEqual(['Sel north drive-thru', 'Sel north kiosk']);
    expect(await picked({ all: [sel, { key: 'region', op: 'missing' }] })).toEqual(['Sel portrait']);
    expect(await picked({ all: [sel, { key: 'region', op: 'exists' }] })).toEqual(['Sel north drive-thru', 'Sel north kiosk', 'Sel south drive-thru']);
  });

  it('pages what it picked', async () => {
    const first = await call('list_screens', { selector: { all: [sel] }, limit: 3 });
    expect(first.screens).toHaveLength(3);
    const rest = await call('list_screens', { selector: { all: [sel] }, limit: 3, cursor: first.next });
    expect(rest).toMatchObject({ screens: [expect.anything()], next: null });
  });

  it('refuses a selector on name, id or status, a reserved key, more than 10 terms, or the wrong number of values', async () => {
    const refused = [
      { all: [{ key: 'name', op: 'eq', values: ['Lobby'] }] },
      { all: [{ key: 'id', op: 'eq', values: [o.screen] }] },
      { all: [{ key: 'status', op: 'eq', values: ['online'] }] },
      { all: [{ key: 'sf.x', op: 'exists' }] },
      { all: [{ key: 'Region', op: 'exists' }] },
      { all: Array.from({ length: 11 }, () => sel) },
      { all: [{ key: 'region', op: 'eq', values: ['a', 'b'] }] },
      { all: [{ key: 'region', op: 'neq' }] },
      { all: [{ key: 'region', op: 'in', values: [] }] },
      { all: [{ key: 'region', op: 'exists', values: ['a'] }] },
      { all: [{ key: 'region', op: 'like', values: ['a'] }] },
      { all: [{ key: 'region', op: 'eq', values: ['\uD800'] }] },
    ];
    for (const selector of refused)
      expect(await run('list_screens', { selector }), JSON.stringify(selector)).toMatchObject({ ok: false, error: 'invalid_input' });
    expect((await run('list_screens', { selector: { all: Array.from({ length: 10 }, () => sel) } })).ok).toBe(true);
  });
});

describe('list_label_keys', () => {
  it('lists keys with their values and counts, one value whatever its case, and the system labels', async () => {
    const own = await seedOrg(env.DB, 'labels-list');
    const scope = testScope(env.DB, own.orgId);
    const as = member(own.orgId, 'viewer');
    const by = member(own.orgId, 'editor');
    const ids = await Promise.all(
      ['A', 'B', 'C'].map(async (n) => (await scope.screens.insert({ name: n, timezone: 'Europe/London', orientation: 'portrait' })).id),
    );
    await call('update_screen_labels', { screenIds: ids.slice(0, 2), set: { type: 'Drive-Thru' } }, by);
    await call('update_screen_labels', { screenIds: [ids[2]!], set: { type: 'drive-thru' } }, by);
    await call('update_screen_labels', { screenIds: [own.screen], set: { type: 'kiosk' } }, by);
    expect(await call('list_label_keys', {}, as)).toEqual({
      keys: [
        { key: 'kind', system: true, screens: 4, values: [{ value: 'device', screens: 4 }] },
        {
          key: 'orientation',
          system: true,
          screens: 4,
          values: [
            { value: 'portrait', screens: 3 },
            { value: 'landscape', screens: 1 },
          ],
        },
        { key: 'region', system: false, screens: 1, values: [{ value: own.orgId, screens: 1 }] },
        { key: 'timezone', system: true, screens: 4, values: [{ value: 'Europe/London', screens: 4 }] },
        {
          key: 'type',
          system: false,
          screens: 4,
          values: [
            { value: 'Drive-Thru', screens: 3 },
            { value: 'kiosk', screens: 1 },
          ],
        },
      ],
      next: null,
    });
  });
});

describe('claim_screen', () => {
  it('takes the first labels, checked as update_screen_labels checks them', async () => {
    await startPairing(env.DB, { code: 'LAB234', pollTokenHash: 'c'.repeat(64), now: NOW });
    const claim = { code: 'LAB234', name: 'Claimed', timezone: 'Europe/London', orientation: 'portrait' };
    expect(await run('claim_screen', { ...claim, labels: { orientation: 'landscape' } })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await run('claim_screen', { ...claim, labels: JSON.parse('{"region":"North","__proto__":"invalid"}') })).toMatchObject({
      ok: false,
      error: 'invalid_input',
    });
    expect(await run('claim_screen', { ...claim, labels: { region: '\uD800' } })).toMatchObject({ ok: false, error: 'invalid_input' });
    const { screen } = await call('claim_screen', { ...claim, labels: { region: ' North ', store: '0142' } });
    expect(screen).toMatchObject({ labels: { region: 'North', store: '0142' }, systemLabels: { orientation: 'portrait' } });
    expect(await labelsOf(screen.id)).toEqual({ region: 'North', store: '0142' });
  });
});
