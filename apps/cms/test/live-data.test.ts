// The live values the spot editor shows read from snapshots as the poller stores them: the
// normalised feed through canonicalJson, which sorts every object's keys.
import { canonicalJson, liveSources, parseTemplateManifest, readPath, type FieldDef, type TemplateManifest } from '@signforge/contract';
import { parseCalendar, parseNews } from '@signforge/feeds';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import twoSources from '../e2e/fixtures/two-sources/template.json';
import { bindAll, guessMapping, madeByEditor, rowTitles, sameWeather, tableRows, typedFields, weatherSource, weatherToKeep } from '../src/lib/live-data';

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

/** A place as find_places gives it. */
const ATLANTA = {
  id: 4180439,
  name: 'Atlanta',
  region: 'Georgia',
  country: 'United States',
  latitude: 33.749,
  longitude: -84.38798,
  timezone: 'America/New_York',
};

describe('madeByEditor', () => {
  it('knows the weather sources the editor makes from a place and units, and nothing a person typed', async () => {
    const live = { source: 'open-meteo' as const, fields: { temp: 'current.temperature_2m', high: 'daily.temperature_2m_max.0' } };
    for (const units of [
      { temperature: '°F', wind: 'mph' },
      { temperature: '°C', wind: 'km/h' },
    ] as const)
      expect(madeByEditor((await weatherSource(live, ATLANTA, units)).id)).toBe(true);
    // A feed or calendar added by its address gets the server's id, or one a person or agent chose.
    for (const id of ['src_8f2k3j4h5g6f7d8s', 'weather', 'news-bbc', 'weather-atlanta', 'weather-4180439-f-mph']) expect(madeByEditor(id), id).toBe(false);
  });

  it('omits daily.time, current.time and top-level timezone from Open-Meteo query variables while keeping forecast_days', async () => {
    const live = {
      source: 'open-meteo' as const,
      fields: {
        weatherTimezone: 'timezone',
        temp: 'current.temperature_2m',
        day1Time: 'daily.time.1',
        day1High: 'daily.temperature_2m_max.1',
        day3Time: 'daily.time.3',
      },
    };
    const url = new URL((await weatherSource(live, ATLANTA, { temperature: '°F', wind: 'mph' })).feedUrl);
    expect(url.searchParams.get('current')?.split(',')).not.toContain('time');
    expect(url.searchParams.get('daily')?.split(',')).not.toContain('time');
    expect(url.searchParams.get('forecast_days')).toBe('4');
  });

  it('gives every base template with a forecast the one source for a place and units, and a template reading more its own (#345, #541)', async () => {
    // Every base template's Open-Meteo sources, found, not named: a new forecast template is held to it too.
    const root = new URL('../../../templates/', import.meta.url);
    const forecasts = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(new URL(`${d.name}/template.json`, root)))
      .flatMap((d) => {
        const { live } = JSON.parse(readFileSync(new URL(`${d.name}/template.json`, root), 'utf8'));
        const sources = live ? (live.sources ? Object.values(live.sources) : [live]) : [];
        return sources.filter((l: { source?: string }) => l.source === 'open-meteo').map((l) => [d.name, l] as const);
      });
    expect(forecasts.map(([name]) => name).toSorted()).toEqual(expect.arrayContaining(['info-frame', 'weather']));
    for (const units of [
      { temperature: '°F', wind: 'mph' },
      { temperature: '°C', wind: 'km/h' },
    ] as const) {
      const ids = new Set(await Promise.all(forecasts.map(async ([, live]) => (await weatherSource(live, ATLANTA, units)).id)));
      expect([...ids], units.temperature).toHaveLength(1);
    }
    // A metric org whose Info frame picker still holds mph, as one with no wind field does: the same source (#541).
    const [, weather] = forecasts.find(([name]) => name === 'weather')!;
    const [, infoFrame] = forecasts.find(([name]) => name === 'info-frame')!;
    expect((await weatherSource(infoFrame, ATLANTA, { temperature: '°C', wind: 'mph' })).id).toBe(
      (await weatherSource(weather, ATLANTA, { temperature: '°C', wind: 'km/h' })).id,
    );
    const more = { source: 'open-meteo' as const, fields: { gust: 'current.wind_gusts_10m' } };
    expect((await weatherSource(more, ATLANTA, { temperature: '°F', wind: 'mph' })).id).not.toBe(
      (await weatherSource(weather, ATLANTA, { temperature: '°F', wind: 'mph' })).id,
    );
  });

  it("keeps a spot on the same place's source it reads when the shared one cannot be made, and on no other (#541)", () => {
    const wanted = 'weather-4180439-c-kmh-aaaaaa';
    const old = 'weather-4180439-c-kmh-bbbbbb';
    expect(weatherToKeep(wanted, [undefined, old], [old, 'news'])).toBe(old);
    expect(weatherToKeep(wanted, [old], ['news'])).toBeUndefined();
    expect(weatherToKeep(wanted, ['weather-4180439-f-mph-bbbbbb'], ['weather-4180439-f-mph-bbbbbb'])).toBeUndefined();
    expect(weatherToKeep(wanted, ['news'], ['news'])).toBeUndefined();
  });

  it('knows two of its ids for the same place and units, whatever variables they ask for (#541)', () => {
    expect(sameWeather('weather-4180439-c-kmh-aaaaaa', 'weather-4180439-c-kmh-bbbbbb')).toBe(true);
    expect(sameWeather('weather-4180439-c-kmh-aaaaaa', 'weather-4180439-f-mph-aaaaaa')).toBe(false);
    expect(sameWeather('weather-4180439-c-kmh-aaaaaa', 'news-feed')).toBe(false);
  });
});

describe('a table template (issue #84)', () => {
  const items: Extract<FieldDef, { type: 'list' }> = {
    type: 'list',
    label: 'Items',
    maxItems: 2,
    item: {
      name: { type: 'text', label: 'Name' },
      description: { type: 'text', label: 'Description', default: '' },
      price: { type: 'text', label: 'Price' },
      tag: { type: 'select', label: 'Tag', options: ['', 'New'], default: '' },
    },
  };
  const manifest = { fields: { title: { type: 'text', label: 'Title' }, items }, live: { source: 'table', fields: { items: 'rows' } } } as const;
  const m: TemplateManifest = {
    ...structuredClone(manifest),
    id: 'menu',
    version: '1.0.0',
    name: 'Menu',
    duration: { defaultMs: 1, minMs: 1, maxMs: 1 },
    orientations: ['landscape'],
    uses: [],
    background: '#000',
  };

  it('guesses each column by its name or a usual other word, and gives each property without a default a column', () => {
    expect(guessMapping(items, ['Section', 'Item', 'Cost', 'Notes'])).toEqual({ columns: { name: 'Item', price: 'Cost' } });
    expect(guessMapping(items, ['A', 'B', 'Description'])).toEqual({ columns: { name: 'A', price: 'B', description: 'Description' } });
    // Property names an org template chose, which are also every object's keys.
    const odd: Extract<FieldDef, { type: 'list' }> = JSON.parse(
      '{"type":"list","label":"Rows","item":{"constructor":{"type":"text","label":"Maker"},"toString":{"type":"text","label":"Label","default":""}}}',
    );
    expect(guessMapping(odd, ['Maker', 'Label'])).toEqual({ columns: { constructor: 'Maker', toString: 'Label' } });
  });

  it('types its list fields until they are bound, then they are live', () => {
    expect(Object.keys(typedFields(m, {}))).toEqual(['title', 'items']);
    const bound = bindAll(m, manifest.live, {}, 'src_menu', ['Item', 'Price']);
    expect(bound).toEqual({ items: { dataSourceId: 'src_menu', path: 'rows', table: { columns: { name: 'Item', price: 'Price' } } } });
    expect(Object.keys(typedFields(m, bound))).toEqual(['title']);
  });

  it('shows the items a screen would, at most maxItems, from the table as the poller stores it', () => {
    const data = stored({
      columns: ['Item', 'Price'],
      rows: [
        ['Tea', 2],
        ['Cake', '$3'],
        ['Pie', '4'],
      ],
    });
    expect(tableRows(m, 'items', { dataSourceId: 'src_menu', path: 'rows', table: { columns: { name: 'Item', price: 'Price' } } }, data, 'en-US')).toEqual({
      items: [
        { name: 'Tea', description: '', price: '2', tag: '' },
        { name: 'Cake', description: '', price: '$3', tag: '' },
      ],
      problems: [],
    });
  });

  it('is a source a person added, which the editor never deletes', () => {
    expect(madeByEditor('src_8f2k3j4h5g6f7d8s')).toBe(false);
  });
});

describe('a template with two sources (#193)', () => {
  // The e2e's fixture: the temperature from a forecast (with its place and unit) and headlines from a feed.
  const parsed = parseTemplateManifest(twoSources);
  if (!parsed.ok) throw new Error(parsed.problems.join('; '));
  const m = parsed.value;

  it("leaves every source's fields and settings out of the typed ones, and binds one source's fields without touching the other's", () => {
    expect(Object.keys(typedFields(m, {}))).toEqual(['city']);
    const weather = { temp: { dataSourceId: 'weather-1', path: 'current.temperature_2m' } };
    expect(bindAll(m, liveSources(m.live!).headlines!, weather, 'news')).toEqual({ ...weather, items: { dataSourceId: 'news', path: 'items' } });
  });
});
