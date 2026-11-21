// A rollout in words: the parts of the bar, in order, each with why its screens wait.
import { describe, expect, it } from 'vitest';
import { rolloutComplete, rolloutLabel, segments, standing, type RolloutScreen } from '../src/lib/publishes';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const screen = (name: string, outcome: RolloutScreen['outcome'], more: Partial<RolloutScreen> = {}): RolloutScreen => ({
  screenId: `scr_${name}`,
  name,
  manifestId: 'm'.repeat(64),
  outcome,
  filesMissing: null,
  wakesAt: null,
  lastSeenAt: null,
  ...more,
});

describe('a rollout', () => {
  it('groups screens by where they stand, playing first, and says why the rest wait', () => {
    const segs = segments(
      { revision: 15, restoresRevision: null },
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
    expect(
      segments({ revision: 4, restoresRevision: 2 }, [screen('Deli', 'playing'), screen('Window', 'downloading')], NOW).map((s) => [s.label, s.why]),
    ).toEqual([
      ['playing v2 again', 'Confirmed by their last check-in.'],
      ['downloading', 'Fetching their files, then they switch.'],
    ]);
    expect(segs[2]!.label).toMatch(/^asleep, update at /);
    expect(segs[3]!.why).toBe('Unreachable for 26 h, playing what they have from their cache.');
    expect(rolloutLabel({ revision: 15, restoresRevision: null }, segs, 6)).toMatch(
      /^Rollout of v15: 2 playing v15, 2 downloading, 1 asleep, update at .+, 1 offline, update when back, of 6 screens$/,
    );
  });

  it('calls a rollout complete once no screen is open: one playing and one revoked is, one still switching is not (#155)', () => {
    // As get_publish counts them: playing, replaced and revoked screens are settled, any other is open.
    expect(rolloutComplete({ screens: 2, open: 0 })).toBe(true);
    expect(rolloutComplete({ screens: 2, open: 1 })).toBe(false);
    expect(rolloutComplete({ screens: 0, open: 0 })).toBe(false);
  });

  it('tells a finished publish its screens played from one replaced before any did', () => {
    const p = {
      id: 'pub_1',
      revision: 2,
      restoresId: null,
      restoresRevision: null,
      by: { kind: 'user', id: 'u', name: 'Maria' },
      createdAt: 0,
      screens: 2,
      open: 0,
    };
    // Played by both, then a later publish switched them: complete, though none plays it now.
    expect(standing({ ...p, finishedAt: 10, reached: 2, playing: 0, replaced: 2 })).toBe('complete');
    expect(standing({ ...p, finishedAt: 10, reached: 1, playing: 0, replaced: 2 })).toBe('played on 1 of 2');
    // Undone before any screen played it.
    expect(standing({ ...p, finishedAt: 10, reached: 0, playing: 0, replaced: 2 })).toBe('moved on');
    expect(standing({ ...p, finishedAt: null, reached: null, playing: 0, replaced: 2 })).toBe('moved on');
    expect(standing({ ...p, finishedAt: null, reached: null, playing: 1, replaced: 0, open: 1 })).toBe('1 of 2');
    expect(standing({ ...p, screens: 0, finishedAt: 10, reached: 0, playing: 0, replaced: 0 })).toBe('reached no screen');
  });
});
