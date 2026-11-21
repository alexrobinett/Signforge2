import { describe, expect, it } from 'vitest';
import {
  CATALOGUE,
  type ConnectionView,
  connectedWords,
  connectionNotice,
  failingWords,
  type ListedSource,
  hasAddress,
  KIND_WORD,
  shows,
  sourcesOf,
  sourceState,
  weatherFixWords,
} from '../src/lib/integrations';

const NOW = Date.parse('2026-11-18T17:40:00Z'); // Wed 9:40 AM in Portland
const clock = { timezone: 'America/Los_Angeles', locale: 'en-US', now: NOW };

const source = (over: Partial<ListedSource> = {}): ListedSource => ({
  id: 'break-room',
  name: 'Break room',
  format: 'ical',
  connectionId: null,
  refreshS: 300,
  horizonDays: null,
  rowsPath: null,
  photos: true,
  nextPollAt: NOW + 60_000,
  failures: 0,
  lastError: null,
  version: 1,
  createdAt: 0,
  updatedAt: 0,
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
    expect(failingWords(failing, clock)).toBe('The Break room calendar answers with an error: its last 2 checks failed. Its screens show the 7:05 AM copy.');
  });

  it('says a source that never had a good check leaves spots on their fallback', () => {
    const never = source({ format: 'rss', name: 'Northside blog', failures: 1, lastError: 'timeout', lastCheckedAt: null });
    expect(failingWords(never, clock)).toBe(
      'The Northside blog feed takes too long to answer: its last check failed. Its spots show their fallback values until a check succeeds.',
    );
  });

  it('says spots fall back once the last good copy is more than a day old, as screens do (SNAPSHOT_STALE_MS)', () => {
    const lastMonday = source({ failures: 9, lastError: 'http-status', lastCheckedAt: Date.parse('2026-11-16T17:40:00Z') });
    expect(failingWords(lastMonday, clock)).toBe(
      'The Break room calendar answers with an error: its last 9 checks failed. Its spots show their fallback values: the last good copy, from Mon 9:40 AM, is more than a day old.',
    );
    // Within the day, screens still show it.
    expect(failingWords(source({ failures: 2, lastError: 'http-status', lastCheckedAt: NOW - 23 * 3_600_000 }), clock)).toContain(
      'Its screens show the Tue 10:40 AM copy.',
    );
  });

  it('gives a time more than 6 days back its date, not a weekday that reads as this week', () => {
    const nineDays = source({ lastCheckedAt: Date.parse('2026-11-09T17:40:00Z') });
    expect(sourceState(nineDays, clock).word).toBe('Nov 9, 9:40 AM');
    expect(failingWords({ ...nineDays, failures: 3, lastError: 'timeout' }, clock)).toContain('from Nov 9, 9:40 AM, is more than a day old');
    expect(sourceState(source({ lastCheckedAt: Date.parse('2026-11-12T17:40:00Z') }), clock).word).toBe('Thu 9:40 AM');
  });

  it('calls a weather source a forecast, not a place', () => {
    expect(failingWords(source({ format: 'json', name: 'Weather, Portland', failures: 1, lastError: 'timeout' }), clock)).toMatch(
      /^The Weather, Portland forecast takes too long to answer: its last check failed\./,
    );
  });

  it("says the spot editor's weather source is the forecast service's to fix, and another place's to choose again", () => {
    // The spot editor names a forecast by its place and units and reuses it by that id: choosing the place again binds the same one.
    expect(weatherFixWords({ id: 'weather-5746545-f-mph-a1b2c3' })).toBe(
      'The forecast service is not answering. SignForge keeps checking it; there is nothing to change here.',
    );
    expect(weatherFixWords({ id: 'src_hand_made' })).toBe('To fix it, choose the place again in a weather spot that uses it.');
  });

  it("words a provider source's failure as what to do about its account", () => {
    const rooms = source({ format: 'provider', name: 'Rooms', connectionId: 'con_1', failures: 3, lastError: 'needs-reconnect' });
    expect(failingWords(rooms, clock)).toBe('The Rooms source needs its account connected again: its last 3 checks failed. Its screens show the 7:05 AM copy.');
  });

  it('says a source with a new address is being checked, until its next poll', () => {
    expect(sourceState(source({ nextPollAt: 0 }), clock)).toEqual({ word: 'checking', tone: 'waiting' });
    expect(sourceState(source({ lastCheckedAt: null }), clock).tone).toBe('waiting');
  });
});

describe('what the connection callback sent back', () => {
  const google: ConnectionView = {
    id: 'con_1',
    provider: 'google',
    account: 'facilities@example.com',
    scopes: [],
    status: 'active',
    expiresAt: null,
    lastError: null,
    createdBy: 'usr_1',
    createdAt: 0,
    updatedAt: 0,
  };

  it('says connected only for a connection the org has', () => {
    expect(connectionNotice({ connected: 'con_1' }, [google])).toBe('Connected facilities@example.com at Google.');
    expect(connectionNotice({ connected: 'bogus' }, [google])).toBeNull();
  });

  it('never repeats an error code it does not know', () => {
    expect(connectionNotice({ connectionError: 'denied' }, [])).toBe('Not connected: the provider says you did not approve it.');
    expect(connectionNotice({ connectionError: 'your account is locked; call 555-0100' }, [])).toBe('Not connected. Connect again.');
  });
});

describe('the catalogue', () => {
  const all = CATALOGUE.flatMap((g) => g.items);
  const count = (show: Parameters<typeof shows>[1], sources: ListedSource[] = []) => all.filter((c) => shows(c, show, '', sources)).length;

  it("has the board's connectors: 5 built, 17 planned and 4 for later", () => {
    expect([count('all'), count('built'), count('planned'), count('later')]).toEqual([26, 5, 17, 4]);
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

describe('CSV and JSON tables (issue #84)', () => {
  const row = CATALOGUE.flatMap((g) => g.items).find((c) => c.name === 'CSV or JSON URL');

  it('are built, one catalogue row for both formats, each named by its format', () => {
    expect(row).toMatchObject({ state: 'built', kind: 'table' });
    const csv = source({ id: 'lunch', format: 'csv' });
    const json = source({ id: 'stock', format: 'json-table', rowsPath: 'data.items' });
    expect(row && sourcesOf(row, [csv, json, source()]).map((s) => s.id)).toEqual(['lunch', 'stock']);
    expect(connectedWords('table', [csv, json])).toBe('2 files');
    expect([KIND_WORD.csv, KIND_WORD['json-table']]).toEqual(['CSV', 'JSON']);
    expect(hasAddress(csv) && hasAddress(json)).toBe(true);
  });

  it('say a file that lost a mapped column, or is not a list, in words', () => {
    expect(failingWords(source({ name: 'Lunch menu', format: 'csv', failures: 1, lastError: 'missing-column' }), clock)).toBe(
      'The Lunch menu file no longer has a column a spot uses: its last check failed. Its screens show the 7:05 AM copy.',
    );
    expect(failingWords(source({ name: 'Stock', format: 'json-table', failures: 2, lastError: 'not-a-table' }), clock)).toMatch(
      /^The Stock file is not a list of objects at its path: its last 2 checks failed\./,
    );
  });
});
