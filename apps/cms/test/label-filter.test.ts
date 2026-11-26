// Finding screens by label (#185): the URL's chips, the selector they are, the search, and group by a key.
import { describe, expect, it } from 'vitest';
import { factsOf, matchesTerms, searchFinds, sectionsBy, selectorOf, termsOf, termsParam, typedTerm, withTerm } from '../src/lib/label-filter';
import type { ScreenView } from '../src/lib/screen-types';

const screen = (name: string, labels: Record<string, string>, orientation = 'landscape') =>
  ({ id: name, name, labels, systemLabels: { orientation, kind: 'device', timezone: 'UTC' }, showing: null }) as unknown as ScreenView;

describe('the chips in the URL', () => {
  it('read `key:value,value` with `;` between, and write back what they read, a comma or semicolon in a value escaped', () => {
    const terms = termsOf('region:north;type:drive-thru, kiosk;note:a%2Cb%3Bc');
    expect(terms).toEqual([
      { key: 'region', values: ['north'] },
      { key: 'type', values: ['drive-thru', 'kiosk'] },
      { key: 'note', values: ['a,b;c'] },
    ]);
    expect(termsParam(terms)).toBe('region:north;type:drive-thru,kiosk;note:a%2Cb%3Bc');
    expect(termsParam([])).toBeUndefined();
    expect(termsOf('Region:North')).toEqual([{ key: 'region', values: ['North'] }]);
  });

  it('leave out what does not read', () => {
    expect(termsOf('region;:north;region:')).toEqual([]);
    expect(termsOf(undefined)).toEqual([]);
    expect(termsOf(['region:north'])).toEqual([]);
  });

  it('are a selector: one value eq, several in; a chip on a key replaces that key’s chip', () => {
    expect(selectorOf(termsOf('region:north;type:a,b'))).toEqual({
      all: [
        { key: 'region', op: 'eq', values: ['north'] },
        { key: 'type', op: 'in', values: ['a', 'b'] },
      ],
    });
    expect(withTerm([{ key: 'region', values: ['north'] }], { key: 'region', values: ['south'] })).toEqual([{ key: 'region', values: ['south'] }]);
  });
});

describe('matching', () => {
  const north = screen('Drive 1', { region: 'North', type: 'drive-thru' });
  const kiosk = screen('Kiosk', { region: 'south', type: 'kiosk' }, 'portrait');
  it('matches labels case-insensitively, and system labels too', () => {
    expect(matchesTerms(north, termsOf('region:north'))).toBe(true);
    expect(matchesTerms(kiosk, termsOf('type:drive-thru,kiosk;orientation:portrait'))).toBe(true);
    expect(matchesTerms(north, termsOf('orientation:portrait'))).toBe(false);
    expect(factsOf(north).kind).toBe('device');
  });

  it('turns a typed key=value into a chip, and searches names, label values and group names', () => {
    expect(typedTerm(' Region = north ')).toEqual({ key: 'region', values: ['north'] });
    expect(typedTerm('north')).toBeUndefined();
    expect(searchFinds(north, 'NORTH', [])).toBe(true);
    expect(searchFinds(kiosk, 'front', ['Front of house'])).toBe(true);
    expect(searchFinds(kiosk, 'north', [])).toBe(false);
  });
});

describe('group by a key', () => {
  it('makes a section per value, folded and named as most spell it, in order, and the screens without it last', () => {
    const screens = [
      screen('A', { store: '0142' }),
      screen('B', { store: '0009' }),
      screen('C', {}),
      screen('D', { store: '0142 ' }),
      screen('E', { store: 'Harbor' }),
      screen('F', { store: 'harbor' }),
      screen('G', { store: 'harbor' }),
    ];
    expect(sectionsBy(screens, 'store').map((s) => [s.value, s.screens.map((x) => x.name)])).toEqual([
      ['0009', ['B']],
      ['0142', ['A', 'D']],
      ['harbor', ['E', 'F', 'G']],
      [null, ['C']],
    ]);
  });
});
