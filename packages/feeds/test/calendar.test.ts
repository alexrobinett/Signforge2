import { describe, expect, it } from 'vitest';
import { FeedError, normaliseFeed, parseCalendar } from '../src/index';
import google from './fixtures/google-calendar.ics?raw';
import outlook from './fixtures/outlook.ics?raw';
import holidays from './fixtures/us-holidays.ics?raw';
import weekly from './fixtures/weekly-meeting.ics?raw';

// Tuesday 17 November 2026, 09:00 in New York.
const now = new Date('2026-11-17T14:00:00Z');

const timed = (title: string, start: string, end: string, location = '') => ({ title, start, end, allDay: false, location });
const allDay = (title: string, start: string, end: string, location = '') => ({ title, start, end, allDay: true, location });

/** A minimal calendar around some VEVENT lines. */
const ics = (...events: string[][]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...events.flatMap((e) => ['BEGIN:VEVENT', ...e, 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n');

describe('runtime', () => {
  it('runs inside workerd', () => {
    expect(navigator.userAgent).toBe('Cloudflare-Workers');
  });
});

describe('weekly recurring meeting with a cancelled and a moved instance', () => {
  const { events } = parseCalendar(weekly, { now });

  it('expands the next 30 days, skipping the cancelled week and moving the moved one', () => {
    expect(events).toEqual([
      timed('Team sync', '2026-11-17T10:00:00-05:00', '2026-11-17T10:30:00-05:00', 'Room 4B'),
      // 24 November is cancelled; 1 December moved to the 2nd, with its own title and room.
      timed('Team sync (moved)', '2026-12-02T14:00:00-05:00', '2026-12-02T14:30:00-05:00', 'Room 2A'),
      timed('Team sync', '2026-12-08T10:00:00-05:00', '2026-12-08T10:30:00-05:00', 'Room 4B'),
      timed('Team sync', '2026-12-15T10:00:00-05:00', '2026-12-15T10:30:00-05:00', 'Room 4B'),
      // Moved in from 22 December, beyond the horizon.
      timed('Team sync (before the break)', '2026-12-16T10:00:00-05:00', '2026-12-16T10:30:00-05:00', 'Room 4B'),
    ]);
  });

  it('keeps the wall-clock time across a DST change', () => {
    const march = parseCalendar(weekly, { now: new Date('2027-03-01T12:00:00Z') }).events.map((e) => e.start);
    expect(march).toEqual([
      '2027-03-02T10:00:00-05:00',
      '2027-03-09T10:00:00-05:00',
      '2027-03-16T10:00:00-04:00',
      '2027-03-23T10:00:00-04:00',
      '2027-03-30T10:00:00-04:00',
    ]);
  });

  it('keeps a meeting that is in progress and drops it once it ends', () => {
    expect(parseCalendar(weekly, { now: new Date('2026-11-17T15:29:00Z') }).events[0]?.start).toBe('2026-11-17T10:00:00-05:00');
    expect(parseCalendar(weekly, { now: new Date('2026-11-17T15:30:00Z') }).events[0]?.start).toBe('2026-12-02T14:00:00-05:00');
  });

  it('drops a series that is cancelled as a whole', () => {
    expect(parseCalendar(weekly.replace('STATUS:CONFIRMED\r\nSUMMARY:Team sync\r\n', 'STATUS:CANCELLED\r\nSUMMARY:Team sync\r\n'), { now }).events).toEqual([]);
  });
});

describe('Google Calendar export', () => {
  it('converts times, drops past, cancelled and far-off events, and expands the standup', () => {
    expect(parseCalendar(google, { now }).events).toEqual([
      // RRULE with UNTIL: weekdays to Friday 20th.
      timed('Standup', '2026-11-17T09:30:00-05:00', '2026-11-17T09:45:00-05:00'),
      timed('Standup', '2026-11-18T09:30:00-05:00', '2026-11-18T09:45:00-05:00'),
      // Floating time: read in X-WR-TIMEZONE.
      timed('Lunch & learn', '2026-11-18T12:00:00-05:00', '2026-11-18T13:00:00-05:00'),
      timed('Design review', '2026-11-18T13:00:00-05:00', '2026-11-18T14:30:00-05:00', 'Room 4B, 2nd floor'),
      timed('Standup', '2026-11-19T09:30:00-05:00', '2026-11-19T09:45:00-05:00'),
      // UTC stays UTC; the folded SUMMARY is unfolded.
      timed('All-hands: Q4 results and the road to the new year in one long title that Google folded', '2026-11-19T17:00:00+00:00', '2026-11-19T18:00:00+00:00', 'Main hall'),
      timed('Standup', '2026-11-20T09:30:00-05:00', '2026-11-20T09:45:00-05:00'),
      // No DTEND: an hour, as datad.py did.
      timed('Fire drill', '2026-11-23T16:00:00-05:00', '2026-11-23T17:00:00-05:00'),
      allDay('Thanksgiving potluck', '2026-11-26', '2026-11-27'),
    ]);
  });
});

describe('Outlook export', () => {
  it("uses the file's VTIMEZONE for Windows zone names and honours EXDATE", () => {
    expect(parseCalendar(outlook, { now }).events).toEqual([
      // "W. Europe Standard Time" has no VTIMEZONE in the file and no X-WR-TIMEZONE: UTC, as datad.py did.
      timed('Call with Berlin office', '2026-11-18T16:00:00+00:00', '2026-11-18T17:00:00+00:00'),
      timed('Vendor call', '2026-11-18T09:00:00-08:00', '2026-11-18T09:30:00-08:00', 'Conference Room 3 (Seattle)'),
      // Thursday 19th is an EXDATE.
      timed('Ops review', '2026-11-23T10:00:00-05:00', '2026-11-23T11:00:00-05:00', 'Microsoft Teams Meeting'),
      allDay('Office closed', '2026-11-26', '2026-11-28'),
      timed('Ops review', '2026-11-26T10:00:00-05:00', '2026-11-26T11:00:00-05:00', 'Microsoft Teams Meeting'),
      timed('Ops review', '2026-11-30T10:00:00-05:00', '2026-11-30T11:00:00-05:00', 'Microsoft Teams Meeting'),
      timed('Ops review', '2026-12-03T10:00:00-05:00', '2026-12-03T11:00:00-05:00', 'Microsoft Teams Meeting'),
      timed('Ops review', '2026-12-07T10:00:00-05:00', '2026-12-07T11:00:00-05:00', 'Microsoft Teams Meeting'),
      timed('Ops review', '2026-12-10T10:00:00-05:00', '2026-12-10T11:00:00-05:00', 'Microsoft Teams Meeting'),
      timed('Ops review', '2026-12-14T10:00:00-05:00', '2026-12-14T11:00:00-05:00', 'Microsoft Teams Meeting'),
    ]);
  });
});

describe('public US holidays feed', () => {
  it('returns the all-day holidays in the next 30 days', () => {
    expect(parseCalendar(holidays, { now }).events).toEqual([
      allDay('Thanksgiving Day', '2026-11-26', '2026-11-27'),
      allDay('Black Friday', '2026-11-27', '2026-11-28'),
    ]);
  });

  it('keeps an all-day event until its day has ended in every time zone', () => {
    const titles = (at: string) => parseCalendar(holidays, { now: new Date(at) }).events.map((e) => e.title);
    expect(titles('2026-11-27T11:59:59Z')).toContain('Thanksgiving Day');
    expect(titles('2026-11-27T12:00:00Z')).not.toContain('Thanksgiving Day');
  });
});

describe('limits', () => {
  const daily = (start: string) => [
    'UID:daily@test',
    `DTSTART:${start}`,
    'DURATION:PT15M',
    'RRULE:FREQ=DAILY',
    'SUMMARY:Daily',
  ];

  it('returns at most 25 events', () => {
    expect(parseCalendar(ics(daily('20261101T120000Z')), { now }).events).toHaveLength(25);
    expect(parseCalendar(ics(daily('20261101T120000Z')), { now, maxEvents: 3 }).events).toHaveLength(3);
  });

  it('counts the 500 occurrences of a series from now, not from its first', () => {
    // Started 600 days and 20 years ago: both still show their next 25 days.
    for (const first of ['20250326T120000Z', '20061117T120000Z']) {
      const events = parseCalendar(ics(daily(first)), { now }).events;
      expect(events[0]?.start).toBe('2026-11-18T12:00:00+00:00');
      expect(events).toHaveLength(25);
    }
    expect(parseCalendar(ics(daily('20261101T120000Z')), { now, maxIterations: 3 }).events.map((e) => e.start)).toEqual([
      '2026-11-18T12:00:00+00:00',
      '2026-11-19T12:00:00+00:00',
      '2026-11-20T12:00:00+00:00',
    ]);
  });

  it('gives up on a series with more than 50,000 occurrences before now', () => {
    const minutely = ['UID:m@test', 'DTSTART:20260101T000000Z', 'DTEND:20260101T000100Z', 'RRULE:FREQ=MINUTELY', 'SUMMARY:Spam'];
    const t = performance.now();
    expect(parseCalendar(ics(minutely), { now }).events).toEqual([]);
    expect(performance.now() - t).toBeLessThan(2000);
  });

  it('refuses a body over the size limit, counting UTF-8 bytes', () => {
    const big = ics(['UID:x', 'DTSTART:20261118T120000Z', `SUMMARY:${'é'.repeat(600_000)}`]);
    expect(() => parseCalendar(big, { now })).toThrow(expect.objectContaining({ code: 'too-large' }));
    expect(() => parseCalendar('x'.repeat(1_000_001), { now })).toThrow(FeedError);
  });

  it('refuses text that is not iCalendar', () => {
    expect(() => parseCalendar('<html>not a calendar</html>', { now })).toThrow(expect.objectContaining({ code: 'malformed' }));
  });
});

describe('edge cases', () => {
  it('treats a moved instance whose series is missing as a single event', () => {
    const orphan = ics(['UID:gone@test', 'RECURRENCE-ID:20261124T150000Z', 'DTSTART:20261125T150000Z', 'DTEND:20261125T160000Z', 'SUMMARY:Orphan']);
    expect(parseCalendar(orphan, { now }).events).toEqual([timed('Orphan', '2026-11-25T15:00:00+00:00', '2026-11-25T16:00:00+00:00')]);
  });

  it('reads a TZID that names an IANA zone even without a VTIMEZONE', () => {
    const tokyo = ics(['UID:t@test', 'DTSTART;TZID=Asia/Tokyo:20261118T090000', 'DTEND;TZID=Asia/Tokyo:20261118T100000', 'SUMMARY:Tokyo']);
    expect(parseCalendar(tokyo, { now }).events).toEqual([timed('Tokyo', '2026-11-18T09:00:00+09:00', '2026-11-18T10:00:00+09:00')]);
  });

  it('defaults an untitled event and skips a broken one without losing the rest', () => {
    const cal = ics(['UID:a@test', 'DTSTART:20261118T120000Z'], ['UID:b@test', 'DTSTART:20261118T130000Z', 'SUMMARY:Fine'], ['UID:c@test', 'SUMMARY:No start']);
    expect(parseCalendar(cal, { now }).events.map((e) => e.title)).toEqual(['Untitled', 'Fine']);
  });

  it('is reachable through normaliseFeed', () => {
    expect(normaliseFeed('ical', weekly, { now }).events).toHaveLength(5);
  });
});
