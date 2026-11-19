// A rollout in words: the parts of the bar, in order, each with why its screens wait.
import { describe, expect, it } from 'vitest';
import { publishResultOf, rolloutLabel, segments, type RolloutScreen } from '../src/lib/publishes';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const screen = (name: string, outcome: RolloutScreen['outcome'], more: Partial<RolloutScreen> = {}): RolloutScreen => ({
  screenId: `scr_${name}`,
  name,
  outcome,
  filesMissing: null,
  wakesAt: null,
  lastSeenAt: null,
  ...more,
});

describe('a rollout', () => {
  it('groups screens by where they stand, playing first, and says why the rest wait', () => {
    const segs = segments(
      { revision: 15 },
      [
        screen('Kitchen', 'asleep', { wakesAt: '2026-11-20T07:00:00Z' }),
        screen('Deli', 'playing'),
        screen('Window', 'downloading', { filesMissing: 3 }),
        screen('Register', 'playing'),
        screen('Café', 'offline', { lastSeenAt: NOW - 26 * 3_600_000 }),
        screen('Coffee', 'downloading', { filesMissing: 2 }),
      ],
      NOW,
    );
    expect(segs.map((s) => [s.outcome, s.count, s.names])).toEqual([
      ['playing', 2, ['Deli', 'Register']],
      ['downloading', 2, ['Window', 'Coffee']],
      ['asleep', 1, ['Kitchen']],
      ['offline', 1, ['Café']],
    ]);
    expect(segs[0]!.label).toBe('playing v15');
    expect(segs[1]!.why).toBe('5 files still to fetch, then they switch.');
    expect(segs[2]!.label).toMatch(/^asleep, update at /);
    expect(segs[3]!.why).toBe('Unreachable for 26 h, playing what they have from their cache.');
    expect(rolloutLabel({ revision: 15 }, segs, 6)).toMatch(
      /^Rollout of v15: 2 playing v15, 2 downloading, 1 asleep, update at .+, 1 offline, update when back, of 6 screens$/,
    );
  });

  it("reads a publish's answer, and refuses one without the publish", () => {
    expect(
      publishResultOf({
        publish: { id: 'pub_1', revision: 3, screens: 2, previousId: 'pub_0' },
        promoted: [],
        held: [{ kind: 'spot', id: 'spt_1', problems: ['no asset'] }],
        screens: [{ screenId: 'scr_1', outcome: 'failed', problems: ['the organization has no default playlist'] }],
      }),
    ).toEqual({
      publish: { id: 'pub_1', revision: 3, screens: 2, previousId: 'pub_0' },
      held: [{ kind: 'spot', id: 'spt_1', problems: ['no asset'] }],
      screens: [{ screenId: 'scr_1', outcome: 'failed', problems: ['the organization has no default playlist'] }],
    });
    expect(publishResultOf({ publish: null, held: [], screens: [] }).publish).toBeNull();
    expect(() => publishResultOf({ screens: [] })).toThrow();
  });
});
