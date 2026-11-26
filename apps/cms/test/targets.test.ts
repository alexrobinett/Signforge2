import { describe, expect, it } from 'vitest';
import { byName, findTargets, groupReach, namesOf, sortScreens } from '../src/lib/targets';

const STATE = { reason: null, wakesAt: null, filesMissing: null };
type Kind = 'online' | 'updating' | 'asleep' | 'unreachable' | 'needs_you';
const screen = (id: string, name: string, kind: Kind = 'online', lastSeenAt: number | null = 0) => ({
  id,
  name,
  lastSeenAt,
  state: { ...STATE, kind },
});
const group = (id: string, name: string, screenIds: string[]) => ({ id, name, screenIds });

const SCREENS = [
  screen('scr_a', '0203 Drive-thru L'),
  screen('scr_b', '0157 Lobby promo'),
  screen('scr_c', '0142 Drive-thru L'),
  screen('scr_d', '0157 Drive-thru R'),
];
const GROUPS = [group('grp_s', 'South region', ['scr_a']), group('grp_n', 'North region', ['scr_b', 'scr_c', 'scr_d'])];

describe('byName', () => {
  it('orders by name as people read it: case aside, and numbers by value', () => {
    const names = ['Screen 10', 'screen 2', 'Lobby', 'Screen 1'];
    expect(
      names
        .map((name, i) => ({ id: String(i), name }))
        .sort(byName)
        .map((s) => s.name),
    ).toEqual(['Lobby', 'Screen 1', 'screen 2', 'Screen 10']);
  });

  it('breaks a tie of names by id, so the order is the same on every read', () => {
    expect([screen('scr_2', 'Lobby'), screen('scr_1', 'Lobby')].sort(byName).map((s) => s.id)).toEqual(['scr_1', 'scr_2']);
  });
});

describe('findTargets', () => {
  it('with no query, lists every group and screen by name', () => {
    const found = findTargets('', SCREENS, GROUPS);
    expect(found.org).toBe(true);
    expect(found.groups.map((g) => g.name)).toEqual(['North region', 'South region']);
    expect(found.screens.map((s) => s.name)).toEqual(['0142 Drive-thru L', '0157 Drive-thru R', '0157 Lobby promo', '0203 Drive-thru L']);
  });

  it('finds screens by part of their name: "0157" lists the 0157 screens', () => {
    const found = findTargets('0157', SCREENS, GROUPS);
    expect(found.screens.map((s) => s.name)).toEqual(['0157 Drive-thru R', '0157 Lobby promo']);
    expect(found.groups).toEqual([]);
    expect(found.org).toBe(false);
  });

  it("finds a screen by its group's name, and the group itself", () => {
    const found = findTargets('south', SCREENS, GROUPS);
    expect(found.groups.map((g) => g.name)).toEqual(['South region']);
    expect(found.screens.map((s) => s.name)).toEqual(['0203 Drive-thru L']);
  });

  it('needs every word, in any order and case, each in the name or a group name', () => {
    expect(findTargets('DRIVE north', SCREENS, GROUPS).screens.map((s) => s.name)).toEqual(['0142 Drive-thru L', '0157 Drive-thru R']);
    expect(findTargets('drive lobby', SCREENS, GROUPS).screens).toEqual([]);
  });

  it('finds every screen as "every" or "all"', () => {
    expect(findTargets('every', SCREENS, GROUPS).org).toBe(true);
    expect(findTargets('all', SCREENS, GROUPS).org).toBe(true);
  });
});

describe('groupReach', () => {
  it('says how many screens a group reaches, and names the first by name', () => {
    expect(groupReach(GROUPS[1]!, SCREENS)).toBe('3 screens: 0142 Drive-thru L, 0157 Drive-thru R, 0157 Lobby promo');
    expect(groupReach(group('g', 'Big', ['scr_a', 'scr_b', 'scr_c', 'scr_d']), SCREENS)).toBe(
      '4 screens: 0142 Drive-thru L, 0157 Drive-thru R, 0157 Lobby promo and 1 more',
    );
    expect(groupReach(GROUPS[0]!, SCREENS)).toBe('1 screen: 0203 Drive-thru L');
    expect(groupReach(group('g', 'Empty', []), SCREENS)).toBe('No screens in it yet');
  });

  it("says a smart group's screens are the ones its rule matches now, and the ones a takeover reaches when sent (#186)", () => {
    const smart = { ...group('g', 'North', ['scr_b', 'scr_c']), selector: { all: [{ key: 'region', op: 'eq', values: ['north'] }] } };
    expect(groupReach(smart, SCREENS)).toBe('Its rule matches 2 screens now: 0142 Drive-thru L, 0157 Lobby promo');
    expect(groupReach(smart, SCREENS, true)).toBe('Reaches these 2 screens now: 0142 Drive-thru L, 0157 Lobby promo');
    expect(groupReach({ ...smart, screenIds: ['scr_a'] }, SCREENS, true)).toBe('Reaches this screen now: 0203 Drive-thru L');
    expect(groupReach({ ...smart, screenIds: [] }, SCREENS)).toBe('Its rule matches no screen now');
  });
});

describe('sortScreens', () => {
  const fleet = [
    screen('scr_1', 'Lobby', 'asleep', 300),
    screen('scr_2', 'Counter', 'online', 100),
    screen('scr_3', 'Window', 'needs_you', null),
    screen('scr_4', 'Back office', 'unreachable', 200),
    screen('scr_5', 'Annex', 'online', 400),
  ];
  const names = (sort: Parameters<typeof sortScreens>[1]) => sortScreens(fleet, sort).map((s) => s.name);

  it('sorts by name, either way', () => {
    expect(names('name')).toEqual(['Annex', 'Back office', 'Counter', 'Lobby', 'Window']);
    expect(names('-name')).toEqual(['Window', 'Lobby', 'Counter', 'Back office', 'Annex']);
  });

  it('sorts by status, most urgent first, asleep (on purpose) last, and by name within a status', () => {
    expect(names('status')).toEqual(['Window', 'Back office', 'Annex', 'Counter', 'Lobby']);
    expect(names('-status')).toEqual(['Lobby', 'Counter', 'Annex', 'Back office', 'Window']);
  });

  it('sorts by last heard, the most recent first, and one never heard from last', () => {
    expect(names('heard')).toEqual(['Annex', 'Lobby', 'Back office', 'Counter', 'Window']);
    expect(names('-heard')).toEqual(['Window', 'Counter', 'Back office', 'Lobby', 'Annex']);
  });

  it('leaves the list it was given as it was', () => {
    sortScreens(fleet, 'name');
    expect(fleet.map((s) => s.id)).toEqual(['scr_1', 'scr_2', 'scr_3', 'scr_4', 'scr_5']);
  });
});

describe('namesOf', () => {
  it("names screens by name, not in the id order a group or a kit's reach lists them", () => {
    expect(namesOf(['scr_a', 'scr_b', 'scr_c'], SCREENS)).toEqual(['0142 Drive-thru L', '0157 Lobby promo', '0203 Drive-thru L']);
  });

  it('names an id no screen has by itself', () => {
    expect(namesOf(['scr_gone', 'scr_c'], SCREENS)).toEqual(['0142 Drive-thru L', 'scr_gone']);
  });
});
