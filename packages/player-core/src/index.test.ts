import { describe, expect, it } from 'vitest';
import type { DataSnapshot, FieldDef, ScreenManifest, Spot, TemplateManifest } from '@signforge/contract';
import { SNAPSHOT_STALE_MS } from '@signforge/contract';
import {
  Sequencer,
  displayOn,
  entryApplies,
  localTime,
  nextDisplayChange,
  planSync,
  resolvePlaylist,
  resolveSpotData,
  snapshotFit,
  spotFiles,
  validateManifest,
} from './index';

const spot = (id: string): Spot => ({ id, name: id, kind: 'image', file: `sha-${id}`, fit: 'cover', durationMs: 5000 });

function manifest(over: Partial<ScreenManifest> = {}): ScreenManifest {
  return {
    schema: 3,
    id: 'm1',
    generatedAt: '2026-11-16T00:00:00Z',
    screen: { id: 's1', name: 'Counter', timezone: 'America/New_York', orientation: 'landscape' },
    files: { 'sha-a': { size: 1, type: 'image/png' }, 'sha-b': { size: 1, type: 'image/png' }, 'sha-c': { size: 1, type: 'image/png' } },
    templates: {},
    spots: { a: spot('a'), b: spot('b'), c: spot('c') },
    playlists: {
      all: { id: 'all', name: 'All day', transition: { type: 'cut' }, items: [{ spot: 'a' }, { spot: 'b' }] },
      breakfast: { id: 'breakfast', name: 'Breakfast', transition: { type: 'cut' }, items: [{ spot: 'c' }] },
      takeover: { id: 'takeover', name: 'Takeover', transition: { type: 'cut' }, items: [{ spot: 'a' }] },
    },
    dataSources: {},
    schedule: [{ id: 'e1', playlist: 'breakfast', priority: 10, target: 'group', from: '06:00', to: '10:00' }],
    defaultPlaylist: 'all',
    ...over,
  };
}

// 2026-11-16 is a Monday. New York is UTC-5 in November.
const at = (hhmm: string) => new Date(`2026-11-16T${hhmm}:00-05:00`);

describe('localTime', () => {
  it('reads the wall clock in the screen time zone, not the host one', () => {
    expect(localTime(new Date('2026-11-16T04:30:00Z'), 'America/New_York')).toEqual({ date: '2026-11-15', day: 0, minutes: 23 * 60 + 30 });
  });
});

describe('schedule', () => {
  it('plays the daypart inside its window and the default outside it', () => {
    expect(resolvePlaylist(manifest(), at('07:30')).id).toBe('breakfast');
    expect(resolvePlaylist(manifest(), at('10:00')).id).toBe('all');
    expect(resolvePlaylist(manifest(), at('05:59')).id).toBe('all');
  });

  it('lets higher priority win, then the more specific target', () => {
    const m = manifest({
      schedule: [
        { id: 'e1', playlist: 'breakfast', priority: 10, target: 'group' },
        { id: 'e2', playlist: 'all', priority: 10, target: 'screen' },
        { id: 'e3', playlist: 'takeover', priority: 99, target: 'org' },
      ],
    });
    expect(resolvePlaylist(m, at('12:00')).id).toBe('takeover');
    m.schedule.pop();
    expect(resolvePlaylist(m, at('12:00')).id).toBe('all');
  });

  it('ends a takeover at its absolute end, whatever the local window says', () => {
    const takeover = {
      id: 't',
      playlist: 'takeover',
      priority: 99,
      target: 'screen' as const,
      startsAt: '2026-11-16T17:00:00Z',
      endsAt: '2026-11-16T17:30:00Z',
    };
    const m = manifest({ schedule: [takeover] });
    expect(resolvePlaylist(m, at('11:59')).id).toBe('all');
    expect(resolvePlaylist(m, at('12:00')).id).toBe('takeover');
    expect(resolvePlaylist(m, at('12:29')).id).toBe('takeover');
    expect(resolvePlaylist(m, at('12:30')).id).toBe('all');
  });

  it('skips bounded entries on a clock it does not trust, so a takeover cannot run forever', () => {
    const m = manifest({ schedule: [{ id: 't', playlist: 'takeover', priority: 99, target: 'screen', endsAt: '2026-11-16T17:30:00Z' }] });
    expect(resolvePlaylist(m, at('12:00'), { clockTrusted: false }).id).toBe('all');
    expect(resolvePlaylist(manifest(), at('07:30'), { clockTrusted: false }).id).toBe('breakfast');
    expect(new Sequencer(m).next(at('12:00'), { clockTrusted: false })?.playlist.id).toBe('all');
    expect(new Sequencer(m).next(at('12:00'))?.playlist.id).toBe('takeover');
  });

  it('handles a window that crosses midnight and belongs to the day it started', () => {
    const late = { id: 'e', playlist: 'all', priority: 1, target: 'screen' as const, from: '22:00', to: '02:00', days: [1] };
    expect(entryApplies(late, localTime(at('23:00'), 'America/New_York'))).toBe(true);
    expect(entryApplies(late, localTime(new Date('2026-11-17T01:00:00-05:00'), 'America/New_York'))).toBe(true);
    expect(entryApplies(late, localTime(new Date('2026-11-18T01:00:00-05:00'), 'America/New_York'))).toBe(false);
  });

  it('dates an overnight window by the day it started', () => {
    const e = { id: 'e', playlist: 'all', priority: 1, target: 'screen' as const, from: '22:00', to: '02:00', startDate: '2026-12-01', endDate: '2026-12-31' };
    expect(entryApplies(e, localTime(new Date('2026-12-01T01:00:00-05:00'), 'America/New_York'))).toBe(false);
    expect(entryApplies(e, localTime(new Date('2026-12-01T23:00:00-05:00'), 'America/New_York'))).toBe(true);
    expect(entryApplies(e, localTime(new Date('2027-01-01T01:00:00-05:00'), 'America/New_York'))).toBe(true);
  });

  it('respects date ranges', () => {
    const e = { id: 'e', playlist: 'all', priority: 1, target: 'screen' as const, startDate: '2026-11-17', endDate: '2026-11-18' };
    expect(entryApplies(e, localTime(at('12:00'), 'America/New_York'))).toBe(false);
    expect(entryApplies(e, localTime(new Date('2026-11-18T23:59:00-05:00'), 'America/New_York'))).toBe(true);
  });
});

describe('display hours', () => {
  const ny = (iso: string) => localTime(new Date(iso), 'America/New_York');
  const hours = {
    weekly: [
      { days: [1, 2, 3, 4, 5], from: '07:00', to: '19:00' },
      { days: [5], from: '22:00', to: '02:00' },
    ],
    exceptions: [
      { date: '2026-11-26', on: [] },
      { date: '2026-11-27', on: [{ from: '10:00', to: '14:00' }] },
    ],
  };

  it('is always on with no hours set', () => {
    expect(displayOn(undefined, ny('2026-11-16T03:00:00-05:00'))).toBe(true);
  });

  it('follows the weekly hours, including the edges', () => {
    expect(displayOn(hours, ny('2026-11-16T06:59:00-05:00'))).toBe(false);
    expect(displayOn(hours, ny('2026-11-16T07:00:00-05:00'))).toBe(true);
    expect(displayOn(hours, ny('2026-11-16T19:00:00-05:00'))).toBe(false);
    expect(displayOn(hours, ny('2026-11-15T12:00:00-05:00'))).toBe(false); // Sunday
  });

  it('keeps an overnight window on into the next morning', () => {
    expect(displayOn(hours, ny('2026-11-21T01:30:00-05:00'))).toBe(true); // Friday night into Saturday
    expect(displayOn(hours, ny('2026-11-21T02:00:00-05:00'))).toBe(false);
  });

  it('lets a dated exception replace the week', () => {
    expect(displayOn(hours, ny('2026-11-26T12:00:00-05:00'))).toBe(false); // closed all day
    expect(displayOn(hours, ny('2026-11-27T09:00:00-05:00'))).toBe(false); // short day
    expect(displayOn(hours, ny('2026-11-27T13:59:00-05:00'))).toBe(true);
    expect(displayOn(hours, ny('2026-11-27T14:00:00-05:00'))).toBe(false);
  });

  it('lets an exception close the morning tail of the night before', () => {
    const fri = { weekly: [{ days: [5], from: '18:00', to: '02:00' }], exceptions: [{ date: '2026-11-20', on: [] }] };
    expect(displayOn(fri, ny('2026-11-21T01:00:00-05:00'))).toBe(false); // Friday closed, so no Saturday-morning tail
    expect(displayOn({ weekly: fri.weekly }, ny('2026-11-21T01:00:00-05:00'))).toBe(true);
  });

  it('accepts 24:00 as the end of the day', () => {
    expect(displayOn({ weekly: [{ days: [1], from: '20:00', to: '24:00' }] }, ny('2026-11-16T23:59:00-05:00'))).toBe(true);
  });
});

describe('Sequencer', () => {
  it('loops the playlist in order and peeks without moving', () => {
    const s = new Sequencer(manifest());
    expect(s.peek(at('12:00'))?.spot.id).toBe('a');
    expect([1, 2, 3].map(() => s.next(at('12:00'))?.spot.id)).toEqual(['a', 'b', 'a']);
  });

  it('switches playlist at the next spot when the daypart changes', () => {
    const s = new Sequencer(manifest());
    expect(s.next(at('05:59'))?.spot.id).toBe('a');
    expect(s.next(at('06:00'))?.spot.id).toBe('c');
    expect(s.next(at('10:00'))?.spot.id).toBe('a');
  });

  it('keeps its place across a manifest swap and skips spots that no longer exist', () => {
    const s = new Sequencer(manifest());
    s.next(at('12:00'));
    const m2 = manifest({ id: 'm2' });
    delete m2.spots.b;
    s.setManifest(m2);
    expect(s.next(at('12:00'))?.spot.id).toBe('a');
  });

  it('returns the same place again after `again`, from the manifest now set', () => {
    const s = new Sequencer(manifest());
    expect(s.next(at('12:00'))?.spot.id).toBe('a');
    const m2 = manifest({ id: 'm2' });
    s.setManifest(m2);
    s.again();
    expect(s.next(at('12:00'))?.spot).toBe(m2.spots.a);
    expect(s.next(at('12:00'))?.spot.id).toBe('b');
  });
});

describe('live data', () => {
  const NOW = Date.parse('2026-11-17T12:00:00Z');
  const weather = {
    id: 'weather',
    version: 1,
    fetchedAt: '2026-11-17T09:00:00Z',
    checkedAt: '2026-11-17T11:55:00Z',
    data: { current: { temp: 41.2 }, daily: { max: [60.6] }, city: 7 },
  };
  const fields: Record<string, FieldDef> = {
    city: { type: 'text', label: 'City' },
    temp: { type: 'number', label: 'Temp', min: -100, max: 100 },
    high: { type: 'number', label: 'High' },
  };
  const bound: Extract<Spot, { kind: 'template' }> = {
    id: 'w',
    name: 'w',
    kind: 'template',
    template: 't@1.0.0',
    durationMs: 5000,
    assets: {},
    data: { city: 'Atlanta', temp: 0, high: 0 },
    bindings: { temp: { source: 'weather', path: 'current.temp' }, high: { source: 'weather', path: 'daily.max.0' } },
  };

  it('overlays snapshot values on the static data', () => {
    expect(resolveSpotData(bound, fields, new Map([['weather', weather]]), NOW, 'en-US')).toEqual({
      data: { city: 'Atlanta', temp: 41.2, high: 60.6 },
      rejected: [],
    });
  });

  it('falls back to the static value when there is no snapshot yet', () => {
    expect(resolveSpotData(bound, fields, new Map(), NOW, 'en-US')).toEqual({ data: bound.data, rejected: [] });
  });

  it('falls back to the static value once the server has not confirmed the snapshot for a day', () => {
    const at = (checkedAt: string) => resolveSpotData(bound, fields, new Map([['weather', { ...weather, checkedAt }]]), NOW, 'en-US').data;
    expect(SNAPSHOT_STALE_MS).toBe(24 * 3_600_000);
    expect(at('2026-11-16T12:00:00Z')).toEqual({ city: 'Atlanta', temp: 41.2, high: 60.6 });
    expect(at('2026-11-16T11:59:59Z')).toEqual(bound.data);
  });

  it('keeps the static value for a live value that does not fit its field, and says why', () => {
    const hot = { ...weather, data: { current: { temp: 400 }, daily: {} } };
    expect(resolveSpotData(bound, fields, new Map([['weather', hot]]), NOW, 'en-US')).toEqual({
      data: bound.data,
      rejected: [
        { source: 'weather', problem: 'field "temp" must be at most 100' },
        { source: 'weather', problem: 'field "high" has no value at the bound path' },
      ],
    });
  });

  it("fills a list field from a table's rows, in the screen's locale, at most maxItems, naming a row left out", () => {
    const listFields: Record<string, FieldDef> = {
      items: {
        type: 'list',
        label: 'Items',
        maxItems: 2,
        item: { name: { type: 'text', label: 'Name' }, price: { type: 'text', label: 'Price', maxLength: 6 } },
      },
    };
    const menu: DataSnapshot = {
      ...weather,
      id: 'menu',
      data: {
        columns: ['Item', 'Price'],
        rows: [
          ['Soup', 4.5],
          ['Feast', 1234.5],
          ['Tea', 2],
          ['Cake', 3],
        ],
      },
    };
    const spot = { ...bound, data: { items: [] }, bindings: { items: { source: 'menu', path: 'rows', table: { columns: { name: 'Item', price: 'Price' } } } } };
    expect(resolveSpotData(spot, listFields, new Map([['menu', menu]]), NOW, 'de-DE')).toEqual({
      data: {
        items: [
          { name: 'Soup', price: '4,50' },
          { name: 'Tea', price: '2' },
        ],
      },
      rejected: [{ source: 'menu', problem: 'field "items": row 2: price is longer than 6' }],
    });
    // A mapped column the file lost: the fallback, and why.
    const lost = { ...menu, data: { columns: ['Dish', 'Price'], rows: [] } };
    expect(resolveSpotData(spot, listFields, new Map([['menu', lost]]), NOW, 'en-US')).toEqual({
      data: { items: [] },
      rejected: [{ source: 'menu', problem: 'field "items": the table has no column "Item"' }],
    });
  });

  it('counts how many bound values in a manifest a snapshot fits', () => {
    const m = manifest();
    const t: TemplateManifest = {
      id: 't',
      version: '1.0.0',
      name: 'T',
      fields,
      background: '#000',
      orientations: ['landscape'],
      uses: [],
      duration: { minMs: 1000, defaultMs: 5000, maxMs: 10_000 },
    };
    m.templates['t@1.0.0'] = { manifest: t, html: 'h' };
    m.spots.w = bound;
    m.spots.other = { ...bound, id: 'other', bindings: { city: { source: 'weather', path: 'city' }, temp: { source: 'elsewhere', path: 'x' } } };
    expect(snapshotFit(m, weather)).toEqual({ fits: 2, problems: ['spot "other": field "city" must be text'] });
    expect(snapshotFit(m, { ...weather, data: {} }).fits).toBe(0);
    expect(snapshotFit(m, { ...weather, id: 'unbound' })).toEqual({ fits: 0, problems: [] });
  });
});

describe('files', () => {
  it('lists what to download and what to drop', () => {
    expect(planSync(manifest(), ['sha-a', 'sha-old'])).toEqual({ missing: ['sha-b', 'sha-c'], stale: ['sha-old'] });
  });

  it('names the files one spot needs: a template spot its bundle and assets, a media spot its file', () => {
    const m = manifest();
    m.templates['base/t@1.0.0'] = { manifest: {} as never, html: 'sha-html' };
    const t: Spot = {
      id: 't',
      name: 't',
      kind: 'template',
      template: 'base/t@1.0.0',
      durationMs: 1000,
      data: {},
      assets: { pic: 'sha-pic', logo: 'sha-logo' },
    };
    expect([...spotFiles(t, m)].sort()).toEqual(['sha-html', 'sha-logo', 'sha-pic']);
    expect([...spotFiles(m.spots.a!, m)]).toEqual(['sha-a']);
    expect([...spotFiles({ id: 'u', name: 'u', kind: 'url', url: 'https://example.com', durationMs: 1000 } as Spot, m)]).toEqual([]);
  });

  it("adds the brand kit's fonts and logo for a template that speaks protocol 2, which reads them as it prepares", () => {
    const m = manifest();
    m.brand = {
      id: 'kit',
      colors: {} as never,
      shape: 'round',
      fonts: { body: { id: 'base/inter', family: 'Inter', files: [{ weight: 400, style: 'normal', file: 'sha-font' }] } },
      logo: { onDark: 'sha-dark', onLight: 'sha-light' },
    };
    const spot = (template: string): Spot => ({ id: 't', name: 't', kind: 'template', template, durationMs: 1000, data: {}, assets: {} });
    m.templates['base/p2@1.0.0'] = { manifest: { protocol: 2 } as never, html: 'sha-p2' };
    m.templates['base/p1@1.0.0'] = { manifest: {} as never, html: 'sha-p1' };
    expect([...spotFiles(spot('base/p2@1.0.0'), m)].sort()).toEqual(['sha-dark', 'sha-font', 'sha-light', 'sha-p2']);
    expect([...spotFiles(spot('base/p1@1.0.0'), m)]).toEqual(['sha-p1']);
  });

  it('rejects a manifest that refers to things it does not carry', () => {
    expect(validateManifest(manifest())).toEqual([]);
    const bad = manifest({ defaultPlaylist: 'nope' });
    delete bad.files['sha-a'];
    expect(validateManifest(bad).length).toBe(2);
  });

  it('rejects values that would crash the player at run time', () => {
    const tz = manifest();
    tz.screen.timezone = 'Mars/Base';
    expect(validateManifest(tz)).toEqual(['screen.timezone "Mars/Base" is not a time zone']);
    const hours = manifest();
    hours.screen.displayHours = { exceptions: [] } as never;
    expect(validateManifest(hours)).toEqual(['display hours have no weekly list']);
    const window = manifest({ schedule: [{ id: 'e', playlist: 'all', priority: 1, target: 'screen', from: '7am' }] });
    expect(validateManifest(window)).toEqual(['schedule entry "e": from must be HH:MM']);
  });

  it('rejects playlists, sources and entries the player could not run', () => {
    const m = manifest({ dataSources: { w: { id: 'w', refreshS: 0 } } });
    (m.playlists.all as { transition?: unknown }).transition = undefined;
    m.schedule[0]!.priority = 'high' as never;
    m.spots.b = { ...m.spots.b!, id: 'not-b' };
    expect(validateManifest(m)).toEqual([
      'spot "b" is listed under a different id ("not-b")',
      'schedule entry "e1": priority must be a number',
      'playlist "all": transition must be cut, fade or crossfade with ms between 1 and 10000',
      'data source "w": refreshS must be at least 60',
    ]);
  });

  it('holds every id to one grammar and accepts the schemas this player supports', () => {
    // A release plays schema N and N-1, so a screen updated while offline keeps its cached manifest.
    expect(validateManifest(manifest({ schema: 3 }))).toEqual([]);
    expect(validateManifest(manifest({ schema: 4 }))).toEqual([]);
    expect(validateManifest(manifest({ schema: 2 }))).toEqual(['manifest schema 2 is not one this player can play (3, 4)']);
    expect(validateManifest(manifest({ schema: 5 }))).toEqual(['manifest schema 5 is not one this player can play (3, 4)']);
    const m = manifest();
    m.screen.id = '../etc';
    expect(validateManifest(m)).toEqual(['screen id "../etc" is not a valid id']);
  });

  it('keys each template by its owner, id and version, so a base and an org template cannot collide', () => {
    const t = {
      id: 'promo',
      version: '1.0.0',
      name: 'P',
      fields: {},
      duration: { defaultMs: 5000, minMs: 1000, maxMs: 9000 },
      orientations: ['landscape' as const],
      uses: [],
      background: '#000',
    };
    const ok = manifest({ templates: { 'base/promo@1.0.0': { manifest: t, html: 'sha-a' }, 'org_42/promo@1.0.0': { manifest: t, html: 'sha-b' } } });
    expect(validateManifest(ok)).toEqual([]);
    const bare = manifest({ templates: { 'promo@1.0.0': { manifest: t, html: 'sha-a' } } });
    expect(validateManifest(bare)).toEqual(['template key "promo@1.0.0" must be <owner>/promo@1.0.0']);
    const empty = manifest({ templates: { 'base/x@1.0.0': { html: 'sha-a' } as never } });
    expect(validateManifest(empty)).toEqual(['template "base/x@1.0.0" has no manifest']);
  });

  it('only accepts https pages for URL spots', () => {
    for (const url of ['', 'javascript:alert(1)', '/index.html', 'http://127.0.0.1:8090/']) {
      const m = manifest();
      m.spots.u = { id: 'u', name: 'u', kind: 'url', url, durationMs: 5000 };
      expect(validateManifest(m)).toEqual(['spot "u" needs an absolute https URL']);
    }
  });
});

describe('nextDisplayChange', () => {
  const weekdays = { weekly: [{ days: [1, 2, 3, 4, 5], from: '07:00', to: '19:00' }] };
  const ny = 'America/New_York';
  const at = (iso: string) => new Date(iso);
  const next = (hours: Parameters<typeof nextDisplayChange>[0], tz: string, iso: string) => nextDisplayChange(hours, tz, at(iso))?.toISOString();

  it('is none for a screen without display hours, or one always on', () => {
    expect(next(undefined, ny, '2026-11-18T15:00:00Z')).toBeUndefined();
    expect(next({ weekly: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '24:00' }] }, ny, '2026-11-18T15:00:00Z')).toBeUndefined();
  });

  it("finds the end of the window it is in, in the screen's time zone", () => {
    // Wed 18 Nov 10:00 in New York (UTC-5) -> 19:00 local.
    expect(next(weekdays, ny, '2026-11-18T15:00:00Z')).toBe('2026-11-19T00:00:00.000Z');
  });

  it('skips the weekend to Monday morning', () => {
    // Fri 20 Nov 20:00 local -> Mon 23 Nov 07:00 local.
    expect(next(weekdays, ny, '2026-11-21T01:00:00Z')).toBe('2026-11-23T12:00:00.000Z');
  });

  it('skips a dated exception that keeps it off all day', () => {
    const hours = { ...weekdays, exceptions: [{ date: '2026-11-26', on: [] }] };
    // Wed 25 Nov 20:00 local: Thursday is closed, so Friday 07:00.
    expect(next(hours, ny, '2026-11-26T01:00:00Z')).toBe('2026-11-27T12:00:00.000Z');
  });

  it('follows an overnight window past midnight', () => {
    expect(next({ weekly: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '22:00', to: '02:00' }] }, 'UTC', '2026-11-18T23:00:00Z')).toBe('2026-11-19T02:00:00.000Z');
  });

  it('crosses a daylight saving change on local time', () => {
    // London goes to BST on Sun 29 Mar 2026; 07:00 local that Monday is 06:00Z.
    const daily = { weekly: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '07:00', to: '19:00' }] };
    expect(next(daily, 'Europe/London', '2026-03-29T20:00:00Z')).toBe('2026-03-30T06:00:00.000Z');
  });
});
