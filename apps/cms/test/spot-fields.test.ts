// A template's fields as a new spot starts them and as the editor checks and draws them, for url
// (#191), date and datetime fields (#192).
import type { FieldDef } from '@signforge/contract';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FieldForm } from '../src/components/spots/field-form';
import { fieldProblems, type SpotDraft, startData } from '../src/lib/spots';

const fields: Record<string, FieldDef> = {
  qrUrl: { type: 'url', label: 'QR link', maxLength: 60 },
  links: { type: 'list', label: 'Links', item: { href: { type: 'url', label: 'Link' } } },
};

describe('a url field in the spot editor', () => {
  it('starts a new spot with no address, which the template reads as no QR code', () => {
    expect(startData(fields)).toEqual({ qrUrl: '', links: [] });
  });

  it("puts the contract's message by the field for an address that is not https, and none for one that is", () => {
    expect(fieldProblems(fields, { data: { qrUrl: 'https://example.com/floor-plan', links: [] }, assets: {} })).toEqual(new Map());
    expect(fieldProblems(fields, { data: { qrUrl: 'http://example.com/floor-plan', links: [] }, assets: {} })).toEqual(
      new Map([['qrUrl', ['field "qrUrl" must be an https address']]]),
    );
  });
});

describe('a photo with its toggle in the spot editor (#252)', () => {
  const fields: Record<string, FieldDef> = {
    photo: { type: 'image', label: 'Photo' },
    showPhoto: { type: 'boolean', label: 'Show the photo', default: true },
  };
  it('asks for a photo while it is shown, and not once it is switched off, as a publish checks it', () => {
    expect(fieldProblems(fields, { data: {}, assets: {} })).toEqual(new Map([['photo', ['image field "photo" has no asset']]]));
    expect(fieldProblems(fields, { data: { showPhoto: false }, assets: {} })).toEqual(new Map());
    expect(fieldProblems(fields, { data: { showPhoto: true }, assets: { photo: 'ast_1' } })).toEqual(new Map());
  });
  it("puts a bad toggle's message by the toggle only", () => {
    expect(fieldProblems(fields, { data: { showPhoto: 'no' }, assets: { photo: 'ast_1' } })).toEqual(
      new Map([['showPhoto', ['field "showPhoto" must be true or false']]]),
    );
  });
});

describe('date and datetime fields in the spot editor', () => {
  const fields: Record<string, FieldDef> = {
    opens: { type: 'date', label: 'Opens', min: '2026-12-01', max: '2026-12-31' },
    target: { type: 'datetime', label: 'Target' },
    events: { type: 'list', label: 'Events', item: { at: { type: 'datetime', label: 'Starts', min: '2026-01-01T00:00' } } },
  };
  /** The `<input>` the form draws for a field, from the spot editor's markup with `data`. */
  const input = (data: Record<string, unknown>, id: string) => {
    const draft: SpotDraft = { name: 'Launch', durationMs: 10_000, data, assets: {}, bindings: {}, assetId: null, fit: 'cover', url: '' };
    const html = renderToStaticMarkup(createElement(FieldForm, { fields, draft, assets: [], onChange: () => {} }));
    return new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? '';
  };

  it("draws the browser's date picker for a date and its date-and-time picker for a datetime, held to the field's min and max", () => {
    const data = { opens: '2026-12-24', target: '2026-12-24T18:00', events: [{ at: '2026-11-27T09:30' }] };
    const opens = input(data, 'field-opens');
    for (const attr of ['type="date"', 'min="2026-12-01"', 'max="2026-12-31"', 'value="2026-12-24"']) expect(opens).toContain(attr);
    const target = input(data, 'field-target');
    for (const attr of ['type="datetime-local"', 'value="2026-12-24T18:00"']) expect(target).toContain(attr);
    expect(target).not.toContain('min=');
    const row = input(data, 'field-events-0-at');
    for (const attr of ['type="datetime-local"', 'min="2026-01-01T00:00"', 'value="2026-11-27T09:30"']) expect(row).toContain(attr);
  });

  it('marks a picker invalid and names the message under it', () => {
    const opens = input({ opens: '2027-01-01', target: '2026-12-24T18:00', events: [] }, 'field-opens');
    for (const attr of ['aria-invalid="true"', 'aria-describedby="field-opens-error"']) expect(opens).toContain(attr);
  });

  it('starts a date at its min, and one with no min empty, which the editor says needs one', () => {
    expect(startData(fields)).toEqual({ opens: '2026-12-01', target: '', events: [] });
    expect(fieldProblems(fields, { data: startData(fields), assets: {} })).toEqual(new Map([['target', ['field "target" has no date and time yet']]]));
  });

  it("puts the contract's message by the field for a day outside min and max, and none for one inside", () => {
    const at = (opens: string) => fieldProblems(fields, { data: { opens, target: '2026-12-24T18:00', events: [] }, assets: {} });
    expect(at('2026-12-24')).toEqual(new Map());
    expect(at('2026-11-30')).toEqual(new Map([['opens', ['field "opens" must be on or after 2026-12-01']]]));
    expect(at('2027-01-01')).toEqual(new Map([['opens', ['field "opens" must be on or before 2026-12-31']]]));
  });
});

describe("a new spot's copy (#253)", () => {
  const fields: Record<string, FieldDef> = {
    look: { type: 'select', label: 'Look', options: ['pop', 'calm'], default: 'pop' },
    headline: { type: 'text', label: 'Headline', maxLength: 80, default: 'Pier 9 opens on Monday' },
    meta: { type: 'text', label: 'Posted by', maxLength: 48, default: 'From the People Team · 20 November' },
    facts: { type: 'list', label: 'Facts', maxItems: 3, item: { label: { type: 'text', label: 'Label' } }, default: [{ label: 'Pier 9 roof terrace' }] },
    showMeta: { type: 'boolean', label: 'Show who posted it', default: true },
    seconds: { type: 'number', label: 'Seconds', default: 10 },
  };

  it("starts its text and lists empty, not with the template's sample copy, and keeps its settings' defaults", () => {
    expect(startData(fields)).toEqual({ headline: '', meta: '', facts: [] });
  });
});
