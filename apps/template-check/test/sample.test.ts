// The data the runtime check renders a template with (#191, #192): every value is one a spot could hold,
// so a template is never refused for data no one could save. No browser, so no render deadlines.
import { type FieldDef, validateSpotData } from '@signforge/contract';
import { describe, expect, it } from 'vitest';
import { exampleData } from '../src/runner/check';

describe('example data for a url field with no default', () => {
  const cases: [string, FieldDef, unknown][] = [
    ['no maxLength: a sample https address', { type: 'url', label: 'Link' }, 'https://example.com/'],
    ['a maxLength the sample fits', { type: 'url', label: 'Link', maxLength: 20 }, 'https://example.com/'],
    ['a maxLength under the sample: a shorter https address', { type: 'url', label: 'Link', maxLength: 15 }, 'https://x.io'],
    ['a maxLength no https address fits: empty, which means none', { type: 'url', label: 'Link', maxLength: 8 }, ''],
  ];
  for (const [what, def, sample] of cases)
    it(`${what}, which the contract accepts`, () => {
      const { data } = exampleData({ link: def });
      expect(data.link).toBe(sample);
      expect(validateSpotData({ link: def }, data, {})).toEqual([]);
    });

  it("keeps a field's own default", () => {
    const fields: Record<string, FieldDef> = { qr: { type: 'url', label: 'QR', maxLength: 30, default: 'https://example.com/plan' } };
    expect(exampleData(fields).data).toEqual({ qr: 'https://example.com/plan' });
  });
});

describe('example data for a date or datetime field with no default', () => {
  const cases: [string, FieldDef, unknown][] = [
    ['a date: a fixed sample day', { type: 'date', label: 'Day' }, '2027-01-15'],
    ['a datetime: a fixed sample wall time', { type: 'datetime', label: 'At' }, '2027-01-15T18:00'],
    ['a min after the sample: the min', { type: 'date', label: 'Day', min: '2027-06-01' }, '2027-06-01'],
    ['a max before the sample: the max', { type: 'datetime', label: 'At', max: '2026-12-31T23:59' }, '2026-12-31T23:59'],
    ['a range around the sample: the sample', { type: 'date', label: 'Day', min: '2027-01-01', max: '2027-12-31' }, '2027-01-15'],
  ];
  for (const [what, def, sample] of cases)
    it(`${what}, which the contract accepts`, () => {
      const { data } = exampleData({ when: def });
      expect(data.when).toBe(sample);
      expect(validateSpotData({ when: def }, data, {})).toEqual([]);
    });
});
