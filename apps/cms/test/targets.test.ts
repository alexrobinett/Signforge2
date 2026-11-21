import { describe, expect, it } from 'vitest';
import { byName, sortScreens } from '../src/lib/targets';

const STATE = { reason: null, wakesAt: null, filesMissing: null };
type Kind = 'online' | 'updating' | 'asleep' | 'unreachable' | 'needs_you';
const screen = (id: string, name: string, kind: Kind = 'online', lastSeenAt: number | null = 0) => ({
  id,
  name,
  lastSeenAt,
  state: { ...STATE, kind },
});
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
