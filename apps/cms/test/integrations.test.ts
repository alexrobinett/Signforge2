import { describe, expect, it } from 'vitest';
import { CATALOGUE, connectedWords, failingWords, type ListedSource, shows, sourceState } from '../src/lib/integrations';

const NOW = Date.parse('2026-11-18T17:40:00Z'); // Wed 9:40 AM in Portland
const clock = { timezone: 'America/Los_Angeles', locale: 'en-US', now: NOW };

const source = (over: Partial<ListedSource> = {}): ListedSource => ({
  id: 'break-room',
  name: 'Break room',
  format: 'ical',
  refreshS: 300,
  horizonDays: null,
  nextPollAt: NOW + 60_000,
  failures: 0,
  lastError: null,
  version: 1,
  lastFetchedAt: Date.parse('2026-11-18T14:00:00Z'),
  lastCheckedAt: Date.parse('2026-11-18T15:05:00Z'),
  spots: [],
  ...over,
});

describe('a source in words', () => {
  it("says when a healthy source was last confirmed, in the org's time", () => {
    expect(sourceState(source(), clock)).toEqual({ word: '7:05 AM', tone: 'ok' });
    expect(sourceState(source({ lastCheckedAt: Date.parse('2026-11-17T15:05:00Z') }), clock).word).toBe('Tue 7:05 AM');
  });

  it('says a failing source failed, and what its feed does and what screens show meanwhile', () => {
    const failing = source({ failures: 2, lastError: 'http-status' });
    expect(sourceState(failing, clock)).toEqual({ word: 'failed 2×', tone: 'failing' });
    expect(failingWords(failing, clock)).toBe('The Break room calendar answers with an error at its last 2 checks. Its screens show the 7:05 AM copy.');
  });

  it('says a source that never had a good check leaves spots on their fallback', () => {
    const never = source({ format: 'rss', name: 'Northside blog', failures: 1, lastError: 'timeout', lastCheckedAt: null, lastFetchedAt: null });
    expect(failingWords(never, clock)).toBe(
      'The Northside blog feed takes too long to answer at its last check. Its spots show their fallback values until a check succeeds.',
    );
  });

  it('says a source with a new address is being checked, until its next poll', () => {
    expect(sourceState(source({ nextPollAt: 0 }), clock)).toEqual({ word: 'checking', tone: 'waiting' });
    expect(sourceState(source({ lastCheckedAt: null, lastFetchedAt: null }), clock).tone).toBe('waiting');
  });
});

describe('the catalogue', () => {
  const all = CATALOGUE.flatMap((g) => g.items);
  const count = (show: Parameters<typeof shows>[1], sources: ListedSource[] = []) => all.filter((c) => shows(c, show, '', sources)).length;

  it("has the board's connectors: 4 built, 18 planned and 4 for later", () => {
    expect([count('all'), count('built'), count('planned'), count('later')]).toEqual([26, 4, 18, 4]);
  });

  it('counts a built connector as connected once the org has a source of its kind', () => {
    expect(count('connected')).toBe(0);
    expect(count('connected', [source(), source({ id: 'news', format: 'rss' })])).toBe(2);
  });

  it('finds a connector by its name or what it does', () => {
    expect(all.filter((c) => shows(c, 'all', 'calendar', [])).map((c) => c.name)).toEqual(['iCal URL', 'Google Calendar', 'Microsoft 365 / Outlook']);
    expect(all.filter((c) => shows(c, 'built', 'SQUARE', [])).length).toBe(0);
  });

  it("counts a connector's sources, and says when one fails", () => {
    expect(connectedWords('rss', [source({ format: 'rss' }), source({ format: 'rss' })])).toBe('2 feeds');
    expect(connectedWords('ical', [source({ failures: 2 })])).toBe('1 calendar · failing');
  });
});
