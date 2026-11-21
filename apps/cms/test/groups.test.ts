import { describe, expect, it } from 'vitest';
import type { BrandKitView } from '../src/lib/brand-kits';
import { needingAttention, targetsOf } from '../src/lib/groups';
import type { ScheduleEntryView } from '../src/lib/schedule';
import type { GroupView, ScreenView } from '../src/lib/screen-types';

const NOW = Date.parse('2026-11-21T12:00:00Z');

const state = (kind: ScreenView['state']['kind'], reason: ScreenView['state']['reason'] = null) => ({ kind, reason, wakesAt: null, filesMissing: null });
const screen = (id: string, s: ScreenView['state']) => ({ id, name: id, state: s }) as ScreenView;
const group = (id: string, screenIds: string[]) => ({ id, name: id, screenIds, version: 1 }) as GroupView;

describe('needingAttention', () => {
  const screens = [
    screen('a', state('online')),
    screen('b', state('needs_you', 'behind')),
    screen('c', state('needs_you', 'revoked')),
    screen('d', state('unreachable')),
  ];

  it('lists only the groups with a screen that needs you, with those screens', () => {
    const out = needingAttention([group('fine', ['a', 'd']), group('front', ['a', 'b'])], screens);
    expect(out.map((g) => [g.group.id, g.needs.map((s) => s.id)])).toEqual([['front', ['b']]]);
  });

  it('names the screens that need you by name, not in the id order the group lists them (#180)', () => {
    const named = [
      { ...screen('scr_1', state('needs_you', 'behind')), name: 'Window' },
      { ...screen('scr_2', state('needs_you', 'fallback')), name: 'Annex' },
    ];
    expect(needingAttention([group('front', ['scr_1', 'scr_2'])], named)[0]!.needs.map((s) => s.name)).toEqual(['Annex', 'Window']);
  });

  it('leaves out a retired screen: a group whose only problem is a revoked screen is fine', () => {
    expect(needingAttention([group('old', ['a', 'c'])], screens)).toEqual([]);
  });
});

describe('targetsOf', () => {
  const entry = (id: string, over: Partial<ScheduleEntryView> = {}) =>
    ({ id, target: 'group', groupId: 'g1', takeover: false, endsAt: null, live: null, ...over }) as ScheduleEntryView;
  const kit = (id: string, groupIds: string[]) => ({ id, name: id, groupIds }) as BrandKitView;

  it("names the entries aimed at the group and the kits it chose, as delete_group counts them: an ended takeover doesn't", () => {
    const entries = [
      entry('e1'),
      entry('e2', { groupId: 'g2' }),
      entry('e3', { target: 'org', groupId: null }),
      entry('ended', { takeover: true, endsAt: '2026-11-21T11:00:00.000Z' }),
      // Ended as drafted, but screens still have it running.
      entry('live', { takeover: true, endsAt: '2026-11-21T11:00:00.000Z', live: { endsAt: '2026-11-21T13:00:00.000Z' } as ScheduleEntryView['live'] }),
    ];
    const out = targetsOf('g1', entries, [kit('k1', ['g1']), kit('k2', ['g2'])], NOW);
    expect(out.entries.map((e) => e.id)).toEqual(['e1', 'live']);
    expect(out.kits.map((k) => k.id)).toEqual(['k1']);
  });
});
