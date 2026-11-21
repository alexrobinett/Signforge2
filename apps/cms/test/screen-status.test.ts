import { describe, expect, it } from 'vitest';
import { describeScreen, summarise, type ScreenLike } from '../src/lib/screen-status';

const NOW = Date.parse('2026-11-18T15:00:00Z'); // Wed 10:00 in New York

const screen = (over: Partial<ScreenLike> = {}): ScreenLike => ({
  timezone: 'America/New_York',
  lastSeenAt: NOW - 12_000,
  state: { kind: 'online', reason: null, wakesAt: null, filesMissing: null },
  showing: {
    asleep: false,
    wakesAt: null,
    playlist: { id: 'p', name: 'Main loop' },
    takeover: false,
    spot: { id: 's', name: 'Spring menu', kind: 'template', template: 'menu-board', image: null },
    spots: 3,
  },
  ...over,
});

describe('describeScreen', () => {
  it('says an online screen is playing its spot', () => {
    expect(describeScreen(screen(), NOW)).toEqual({ tone: 'online', word: 'Online', line: 'Playing Spring menu · as scheduled' });
  });

  it("says when an asleep screen wakes, in the screen's own time", () => {
    const asleep = screen({ state: { kind: 'asleep', reason: null, wakesAt: '2026-11-19T12:00:00.000Z', filesMissing: null } });
    expect(describeScreen(asleep, NOW)).toEqual({ tone: 'asleep', word: 'Asleep · wakes Thu 07:00', line: 'Asleep on purpose, for its display hours' });
    const today = screen({ state: { kind: 'asleep', reason: null, wakesAt: '2026-11-18T17:30:00.000Z', filesMissing: null } });
    expect(describeScreen(today, NOW).word).toBe('Asleep · wakes 12:30');
  });

  it('keeps an unreachable screen on the latest version calm, and says what it still plays', () => {
    const away = screen({ lastSeenAt: NOW - 2 * 3_600_000 - 60_000, state: { kind: 'unreachable', reason: null, wakesAt: null, filesMissing: null } });
    expect(describeScreen(away, NOW)).toEqual({ tone: 'offline', word: 'Unreachable 2 h', line: 'Unreachable 2 h · still playing Spring menu' });
    expect(describeScreen(screen({ lastSeenAt: null, state: { kind: 'unreachable', reason: null, wakesAt: null, filesMissing: null } }), NOW)).toMatchObject({
      word: 'Not heard from yet',
    });
  });

  it('says why a screen needs you, in red', () => {
    const needs = (reason: NonNullable<ScreenLike['state']['reason']>) =>
      describeScreen(screen({ state: { kind: 'needs_you', reason, wakesAt: null, filesMissing: null } }), NOW);
    expect(needs('behind')).toEqual({
      tone: 'needs-you',
      word: 'Needs you',
      line: 'Unreachable and behind: it missed the latest publish, and plays an older version from its cache',
    });
    expect(needs('revoked').line).toMatch(/revoked/);
    expect(needs('nothing_published').line).toBe('Nothing is published to it yet');
    expect(needs('fallback').line).toMatch(/went back/);
  });

  it('counts the files an updating screen still has to fetch', () => {
    expect(describeScreen(screen({ state: { kind: 'updating', reason: null, wakesAt: null, filesMissing: 4 } }), NOW)).toEqual({
      tone: 'updating',
      word: 'Updating',
      line: 'Fetching the new version, 4 files to go · still playing the last one',
    });
  });
});

describe('summarise', () => {
  it('reads as one line of facts', () => {
    const k = (kind: ScreenLike['state']['kind']) => ({ state: { kind } });
    expect(summarise([k('online'), k('online'), k('updating'), k('asleep'), k('unreachable'), k('needs_you')])).toBe(
      '6 screens · 4 playing now · 1 asleep on purpose · 1 unreachable, still playing · 1 needs you',
    );
    expect(summarise([k('online')])).toBe('1 screen · 1 playing now');
  });
});
