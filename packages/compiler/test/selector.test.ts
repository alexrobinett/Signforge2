import { describe, expect, it } from 'vitest';
import { format, matches, systemLabels, type Selector, groupsOf } from '../src/selector';

const lobby = {
  region: 'North',
  type: 'Drive-Thru',
  store: '0142',
  ...systemLabels({ orientation: 'portrait', kind: 'device', timezone: 'Europe/London', locale: null }),
};
const bare = systemLabels({ orientation: 'landscape', kind: 'browser', timezone: 'America/Chicago', locale: 'en-US' });

const one = (key: string, op: Selector['all'][number]['op'], ...values: string[]): Selector => ({ all: [{ key, op, values }] });

describe('systemLabels', () => {
  it("are the screen's settings, with no locale when it has none", () => {
    expect(systemLabels({ orientation: 'portrait', kind: 'device', timezone: 'Europe/London', locale: null })).toEqual({
      orientation: 'portrait',
      kind: 'device',
      timezone: 'Europe/London',
    });
    expect(bare).toEqual({ orientation: 'landscape', kind: 'browser', timezone: 'America/Chicago', locale: 'en-US' });
  });
});

describe('matches', () => {
  it('compares values case-insensitively and trimmed', () => {
    expect(matches(one('region', 'eq', 'north'), lobby)).toBe(true);
    expect(matches(one('type', 'eq', ' DRIVE-THRU '), lobby)).toBe(true);
    expect(matches(one('region', 'eq', 'south'), lobby)).toBe(false);
    expect(matches(one('region', 'in', 'south', 'NORTH'), lobby)).toBe(true);
    expect(matches(one('region', 'notin', 'south', 'NORTH'), lobby)).toBe(false);
    expect(matches(one('region', 'neq', 'NoRtH'), lobby)).toBe(false);
  });

  it('never lets a missing key equal anything, so != and notin need the key', () => {
    expect(matches(one('region', 'neq', 'north'), bare)).toBe(false);
    expect(matches(one('region', 'notin', 'north', 'south'), bare)).toBe(false);
    expect(matches(one('region', 'neq', 'south'), lobby)).toBe(true);
    expect(matches(one('region', 'notin', 'south'), lobby)).toBe(true);
    expect(matches(one('region', 'eq', 'north'), bare)).toBe(false);
    expect(matches(one('region', 'in', 'north'), bare)).toBe(false);
  });

  it('tells a key there from a key missing', () => {
    expect(matches(one('store', 'exists'), lobby)).toBe(true);
    expect(matches(one('store', 'exists'), bare)).toBe(false);
    expect(matches(one('store', 'missing'), bare)).toBe(true);
    expect(matches(one('store', 'missing'), lobby)).toBe(false);
  });

  it('reads system labels as labels: orientation=portrait needs no one to type it', () => {
    expect(matches(one('orientation', 'eq', 'portrait'), lobby)).toBe(true);
    expect(matches(one('orientation', 'eq', 'portrait'), bare)).toBe(false);
    expect(matches(one('kind', 'eq', 'browser'), bare)).toBe(true);
    expect(matches(one('timezone', 'eq', 'europe/london'), lobby)).toBe(true);
    expect(matches(one('locale', 'missing'), lobby)).toBe(true);
    expect(matches(one('locale', 'eq', 'EN-us'), bare)).toBe(true);
  });

  it('needs every term to hold, and takes every screen with no terms', () => {
    const northDriveThru: Selector = {
      all: [
        { key: 'region', op: 'eq', values: ['north'] },
        { key: 'type', op: 'in', values: ['drive-thru', 'kiosk'] },
      ],
    };
    expect(matches(northDriveThru, lobby)).toBe(true);
    expect(matches(northDriveThru, { ...lobby, type: 'kiosk' })).toBe(true);
    expect(matches(northDriveThru, { ...lobby, type: 'counter' })).toBe(false);
    expect(matches({ all: [] }, bare)).toBe(true);
  });
});

describe('format', () => {
  it('writes a selector as people read it', () => {
    expect(
      format({
        all: [
          { key: 'region', op: 'eq', values: ['north'] },
          { key: 'type', op: 'in', values: ['drive-thru', 'kiosk'] },
          { key: 'legacy', op: 'missing', values: [] },
        ],
      }),
    ).toBe('region=north, type in (drive-thru, kiosk), !legacy');
    expect(
      format({
        all: [
          { key: 'region', op: 'neq', values: ['South'] },
          { key: 'store', op: 'notin', values: ['0142', '0143'] },
          { key: 'store', op: 'exists', values: [] },
        ],
      }),
    ).toBe('region!=South, store notin (0142, 0143), store');
  });

  it('writes no terms as nothing', () => {
    expect(format({ all: [] })).toBe('');
  });

  it('quotes and escapes values that would collide with selector syntax', () => {
    const literalComma: Selector = { all: [{ key: 'region', op: 'eq', values: ['north, !legacy'] }] };
    const twoTerms: Selector = {
      all: [
        { key: 'region', op: 'eq', values: ['north'] },
        { key: 'legacy', op: 'missing', values: [] },
      ],
    };
    expect(format(literalComma)).toBe('region="north, !legacy"');
    expect(format(twoTerms)).toBe('region=north, !legacy');
    expect(format(literalComma)).not.toBe(format(twoTerms));

    const oneListValue: Selector = { all: [{ key: 'type', op: 'in', values: ['drive-thru, kiosk'] }] };
    const twoListValues: Selector = { all: [{ key: 'type', op: 'in', values: ['drive-thru', 'kiosk'] }] };
    expect(format(oneListValue)).toBe('type in ("drive-thru, kiosk")');
    expect(format(twoListValues)).toBe('type in (drive-thru, kiosk)');

    const injectedParens: Selector = { all: [{ key: 'type', op: 'notin', values: ['x), !legacy, type in (y'] }] };
    expect(format(injectedParens)).toBe('type notin ("x), !legacy, type in (y")');

    // Values with quotes, backslashes, parens or edge spaces are quoted and escaped; ordinary spaces stay plain.
    expect(format(one('region', 'eq', 'North Side'))).toBe('region=North Side');
    expect(format(one('region', 'eq', '"north"'))).toBe('region="\\"north\\""');
    expect(format(one('region', 'neq', 'a\\b'))).toBe('region!="a\\\\b"');
    expect(format(one('region', 'in', 'say "hi"', '(east)', ' padded ', ''))).toBe('region in ("say \\"hi\\"", "(east)", " padded ", "")');
  });
});

describe("each screen's groups (#186)", () => {
  const screen = (id: string, labels: Record<string, string>, orientation: 'landscape' | 'portrait' = 'landscape') => ({
    id,
    labels,
    orientation,
    kind: 'device' as const,
    timezone: 'UTC',
    locale: null,
  });

  it('puts a screen in a list group by its rows and in a smart group by its rule, system labels included', () => {
    const screens = [screen('a', { region: 'North', type: 'drive-thru' }), screen('b', { region: 'north' }, 'portrait'), screen('c', {})];
    // grp_list is a list group: rows, no rule.
    const rules = [
      {
        id: 'grp_north_drive',
        selector: {
          all: [
            { key: 'region', op: 'eq' as const, values: ['north'] },
            { key: 'type', op: 'eq' as const, values: ['drive-thru'] },
          ],
        },
      },
      { id: 'grp_portrait', selector: { all: [{ key: 'orientation', op: 'eq' as const, values: ['portrait'] }] } },
    ];
    const members = [
      { groupId: 'grp_list', screenId: 'c' },
      // A row left under a group that has become a rule counts for nothing: the rule decides.
      { groupId: 'grp_north_drive', screenId: 'c' },
    ];
    expect(Object.fromEntries(groupsOf(screens, rules, members))).toEqual({
      a: ['grp_north_drive'],
      b: ['grp_portrait'],
      c: ['grp_list'],
    });
  });
});
