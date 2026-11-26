// The label editor's rules (#185): rows to labels, the change update_screen_labels takes, and the typo guard.
import { describe, expect, it } from 'vitest';
import { acrossWords, labelChange, labelProblems, labelRows, labelsAcross, labelsOf, labelsReady, lonelyValue, type LabelKey } from '../src/lib/labels';

const keys: LabelKey[] = [
  {
    key: 'region',
    system: false,
    screens: 8,
    values: [
      { value: 'North', screens: 6 },
      { value: 'south', screens: 2 },
    ],
  },
  { key: 'store', system: false, screens: 1, values: [{ value: '0142', screens: 1 }] },
  { key: 'orientation', system: true, screens: 9, values: [{ value: 'landscape', screens: 9 }] },
];

describe('label rows', () => {
  it('lists a screen’s labels by key, and reads rows back trimmed, keys lowercased, half-typed rows left out', () => {
    expect(labelRows({ store: '0142', region: 'north' })).toEqual([
      { key: 'region', value: 'north' },
      { key: 'store', value: '0142' },
    ]);
    expect(
      labelsOf([
        { key: ' Region ', value: '  north ' },
        { key: 'type', value: ' ' },
        { key: '', value: 'x' },
      ]),
    ).toEqual({ region: 'north' });
  });

  it('gives the change from what is saved: keys set or changed, keys gone; none when nothing changed', () => {
    const before = { region: 'north', store: '0142' };
    expect(
      labelChange(before, [
        { key: 'region', value: 'south' },
        { key: 'type', value: 'kiosk' },
      ]),
    ).toEqual({ set: { region: 'south', type: 'kiosk' }, remove: ['store'] });
    expect(
      labelChange(before, [
        { key: 'store', value: '0142 ' },
        { key: 'region', value: 'north' },
      ]),
    ).toBeNull();
  });
});

describe('the typo guard', () => {
  it('warns of a value no other screen has, folded as selectors fold it', () => {
    expect(lonelyValue(keys, { key: 'region', value: 'nrth' })).toBe('nrth: no other screen has this value');
    expect(lonelyValue(keys, { key: 'region', value: ' NORTH ' })).toBeUndefined();
  });

  it('does not count the screen’s own value for itself', () => {
    expect(lonelyValue(keys, { key: 'store', value: '0142' }, { store: '0142' })).toBe('0142: no other screen has this value');
    expect(lonelyValue(keys, { key: 'store', value: '0142' })).toBeUndefined();
  });

  it('says nothing of a new key, a system key or an empty value', () => {
    expect(lonelyValue(keys, { key: 'floor', value: '2' })).toBeUndefined();
    expect(lonelyValue(keys, { key: 'orientation', value: 'sideways' })).toBeUndefined();
    expect(lonelyValue(keys, { key: 'region', value: '' })).toBeUndefined();
  });
});

describe('rows that cannot be saved as they are (review of #597)', () => {
  it('flags a key another row has once lowercased, on the later row', () => {
    const rows = [
      { key: 'floor', value: '1' },
      { key: 'Floor', value: '2' },
    ];
    expect(labelProblems(rows)).toEqual([undefined, 'floor: another row has this key. Keep one.']);
    expect(labelsReady(rows)).toBe(false);
  });

  it('flags a key with no value and a value with no key, and leaves an empty row alone', () => {
    expect(
      labelProblems([
        { key: 'store', value: ' ' },
        { key: '', value: 'north' },
        { key: '', value: '' },
      ]),
    ).toEqual(['store: give it a value, or remove the row.', 'Give it a key, or remove the row.', undefined]);
    expect(
      labelsReady([
        { key: 'region', value: 'north' },
        { key: '', value: '' },
      ]),
    ).toBe(true);
  });
});

describe('a selection’s labels, for the bulk dialog', () => {
  it('counts each key’s values, folded and named as most spell them, and the screens with none', () => {
    const across = labelsAcross([
      { labels: { region: 'north', store: '0142' } },
      { labels: { region: 'North' } },
      { labels: { region: 'north' } },
      { labels: { region: 'south' } },
      { labels: {} },
    ]);
    expect(across).toEqual([
      {
        key: 'region',
        values: [
          { value: 'north', screens: 3 },
          { value: 'south', screens: 1 },
        ],
        none: 1,
      },
      { key: 'store', values: [{ value: '0142', screens: 1 }], none: 4 },
    ]);
    expect(across.map(acrossWords)).toEqual(['north (3), south (1), none (1)', '0142 (1), none (4)']);
  });
});
