// The live values the spot editor shows read from snapshots as the poller stores them: the
// normalised feed through canonicalJson, which sorts every object's keys.
import { canonicalJson, readPath } from '@signforge/contract';
import { parseCalendar, parseNews } from '@signforge/feeds';
import { describe, expect, it } from 'vitest';
import { madeByEditor, rowTitles, weatherSource } from '../src/lib/live-data';

/** What the poller writes as a snapshot's data (apps/api/src/data/poller.ts). */
const stored = (feed: unknown): unknown => JSON.parse(canonicalJson(feed));

describe('rowTitles', () => {
  it("shows a news feed's headlines, dated or not, and whatever its source", () => {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>World</title><language>en</language>
      <item><title>Harbour bridge reopens after repairs</title><pubDate>Wed, 18 Nov 2026 10:00:00 GMT</pubDate></item>
      <item><title>City library extends its weekend hours</title></item>
    </channel></rss>`;
    expect(rowTitles(readPath(stored(parseNews(rss)), 'items'))).toEqual(['Harbour bridge reopens after repairs', 'City library extends its weekend hours']);
  });

  it("shows a calendar's event titles, not their times", () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//SignForge//test//EN',
      'BEGIN:VEVENT',
      'UID:1',
      'DTSTART:20261120T150000Z',
      'DTEND:20261120T160000Z',
      'SUMMARY:Staff meeting',
      'LOCATION:Room 4B',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n');
    const feed = parseCalendar(ics, { now: new Date('2026-11-19T00:00:00Z') });
    expect(rowTitles(readPath(stored(feed), 'events'))).toEqual(['Staff meeting']);
  });
});

describe('madeByEditor', () => {
  it('knows the weather sources the editor makes from a place and units, and nothing a person typed', async () => {
    const live = { source: 'open-meteo' as const, fields: { temp: 'current.temperature_2m', high: 'daily.temperature_2m_max.0' } };
    const place = {
      id: 4180439,
      name: 'Atlanta',
      region: 'Georgia',
      country: 'United States',
      latitude: 33.749,
      longitude: -84.38798,
      timezone: 'America/New_York',
    };
    for (const units of [
      { temperature: '°F', wind: 'mph' },
      { temperature: '°C', wind: 'km/h' },
    ] as const)
      expect(madeByEditor((await weatherSource(live, place, units)).id)).toBe(true);
    // A feed or calendar added by its address gets the server's id, or one a person or agent chose.
    for (const id of ['src_8f2k3j4h5g6f7d8s', 'weather', 'news-bbc', 'weather-atlanta', 'weather-4180439-f-mph']) expect(madeByEditor(id), id).toBe(false);
  });
});
