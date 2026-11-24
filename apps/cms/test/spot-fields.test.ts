// A template's fields as a new spot starts them and as the editor checks and draws them, for url
// (#191), date and datetime fields (#192).
import { type FieldDef, type TemplateManifest, validateSpotData } from '@signforge/contract';
import { type ComponentProps, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { FieldForm } from '../src/components/spots/field-form';
import { startData } from '@signforge/compiler/draft';
import { typedFields } from '../src/lib/live-data';
import { fieldProblems, type SpotDraft } from '../src/lib/spots';
import { StoreProvider } from '../src/state/provider';

// The image field's picker asks the page's router for the member's role, which a static render has none of.
vi.mock('~/lib/live', async (real) => ({ ...(await real<typeof import('../src/lib/live')>()), useCanManage: () => false }));

/**
 * The form's markup, as the spot editor draws it for spot `s1`: inside a store with only what the
 * form reads, `checks` saying which fields were touched and whether Publish was pressed.
 */
function formHtml(props: Omit<ComponentProps<typeof FieldForm>, 'spotId' | 'onChange'>, checks?: { touched: string[]; all: boolean }) {
  const store = createStore(() => ({
    spotEditor: { picking: null, checks: checks ? { s1: checks } : {} },
    assets: { pickerQuery: '' },
    pickImageFor: () => {},
    searchPicker: () => {},
    touchField: () => {},
  }));
  const form = createElement(FieldForm, { ...props, spotId: 's1', onChange: () => {} });
  // StoreProvider's props name its children; built apart, as createElement's arguments cannot satisfy them.
  const provider: ComponentProps<typeof StoreProvider> = { store: store as never, children: form };
  return renderToStaticMarkup(createElement(StoreProvider, provider));
}

const fields: Record<string, FieldDef> = {
  qrUrl: { type: 'url', label: 'QR link', maxLength: 60 },
  links: { type: 'list', label: 'Links', item: { href: { type: 'url', label: 'Link' } } },
};

describe('a url field in the spot editor', () => {
  it('starts a new spot with no address, which the template reads as no QR code', () => {
    expect(startData(fields)).toEqual({ qrUrl: '', links: [] });
  });

  it("puts the contract's message by the field for an address that is not https, and none for one that is", () => {
    expect(fieldProblems(fields, { data: { qrUrl: 'https://example.com/floor-plan', links: [] }, assets: {}, bindings: {} })).toEqual(new Map());
    expect(fieldProblems(fields, { data: { qrUrl: 'http://example.com/floor-plan', links: [] }, assets: {}, bindings: {} })).toEqual(
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
    expect(fieldProblems(fields, { data: {}, assets: {}, bindings: {} })).toEqual(new Map([['photo', ['image field "photo" has no asset']]]));
    expect(fieldProblems(fields, { data: { showPhoto: false }, assets: {}, bindings: {} })).toEqual(new Map());
    expect(fieldProblems(fields, { data: { showPhoto: true }, assets: { photo: 'ast_1' }, bindings: {} })).toEqual(new Map());
  });
  it("puts a bad toggle's message by the toggle only", () => {
    expect(fieldProblems(fields, { data: { showPhoto: 'no' }, assets: { photo: 'ast_1' }, bindings: {} })).toEqual(
      new Map([['showPhoto', ['field "showPhoto" must be true or false']]]),
    );
  });
  it('asks for a photo when its toggle is bound to live data, even with a static false, as a publish does (#285)', () => {
    const draft: SpotDraft = {
      name: 'Welcome',
      durationMs: 10_000,
      data: { showPhoto: false },
      assets: {},
      bindings: { showPhoto: { dataSourceId: 'src_1', path: 'show' } },
      assetId: null,
      fit: 'cover',
      url: '',
    };
    expect(fieldProblems(fields, draft)).toEqual(new Map([['photo', ['image field "photo" has no asset']]]));
  });
});

describe('a photo whose toggle is a live field (#304)', () => {
  const manifest: Pick<TemplateManifest, 'fields' | 'live'> = {
    fields: {
      photo: { type: 'image', label: 'Photo' },
      showPhoto: { type: 'boolean', label: 'Show the photo', default: true },
    },
    live: { source: 'rss', fields: { showPhoto: 'show' } },
  };
  it('says nothing about the photo while the unbound toggle is off, as a publish does', () => {
    const draft: SpotDraft = {
      name: 'Welcome',
      durationMs: 10_000,
      data: { showPhoto: false },
      assets: {},
      bindings: {},
      assetId: null,
      fit: 'cover',
      url: '',
    };
    expect(validateSpotData(manifest.fields, draft.data, draft.assets, draft.bindings)).toEqual([]);
    const html = formHtml({ fields: manifest.fields, shown: typedFields(manifest, draft.bindings), draft, assets: [] }, { touched: [], all: true });
    expect(html).toContain('Choose image');
    // The live toggle is checked but not drawn: before #304 the form drew only what it checked.
    expect(html).not.toContain('Show the photo');
    expect(html).not.toContain('No image for');
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
    const html = formHtml({ fields, shown: fields, draft, assets: [] });
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
    expect(fieldProblems(fields, { data: startData(fields), assets: {}, bindings: {} })).toEqual(
      new Map([['target', ['field "target" has no date and time yet']]]),
    );
  });

  it("puts the contract's message by the field for a day outside min and max, and none for one inside", () => {
    const at = (opens: string) => fieldProblems(fields, { data: { opens, target: '2026-12-24T18:00', events: [] }, assets: {}, bindings: {} });
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

describe('a new spot in the editor (#359)', () => {
  const promo: Record<string, FieldDef> = {
    look: { type: 'select', label: 'Look', options: ['pop', 'poster'], default: 'pop' },
    units: { type: 'select', label: 'Wind unit', options: ['mph', 'km/h'], default: 'mph' },
    tag: { type: 'select', label: 'Tag', options: ['', 'New'], default: '' },
    headline: { type: 'text', label: 'Headline', maxLength: 12 },
    photo: { type: 'image', label: 'Photo' },
    showPhoto: { type: 'boolean', label: 'Show the photo', default: true },
  };
  const draft = (data: Record<string, unknown>): SpotDraft => ({
    name: 'Promo',
    durationMs: 8000,
    data,
    assets: {},
    bindings: {},
    assetId: null,
    fit: 'cover',
    url: '',
  });

  it("says nothing of an empty field until it is touched or Publish is pressed, then says it in words, by the field's label", () => {
    const fresh = formHtml({ fields: promo, shown: promo, draft: draft({}), assets: [] });
    expect(fresh).not.toContain('field "');
    expect(fresh).not.toContain('No image for');
    expect(fresh).not.toContain('aria-invalid="true"');
    expect(formHtml({ fields: promo, shown: promo, draft: draft({}), assets: [] }, { touched: ['headline'], all: false })).toContain('Headline is empty.');
    const published = formHtml({ fields: promo, shown: promo, draft: draft({}), assets: [] }, { touched: [], all: true });
    expect(published).toContain('No image for Photo: choose one, or untick Show the photo.');
    expect(published).toContain('Headline is empty.');
  });

  it('says a value that is wrong at once, untouched, in words', () => {
    expect(formHtml({ fields: promo, shown: promo, draft: draft({ headline: 'Far too long a headline' }), assets: [] })).toContain(
      'Headline is longer than 12 characters.',
    );
  });

  it("shows a choice's options by their labels: a word capitalised, a unit as written, none as None", () => {
    const html = formHtml({ fields: promo, shown: promo, draft: draft({ headline: 'Hi' }), assets: [] });
    for (const option of [
      '<option value="pop" selected="">Pop</option>',
      '<option value="poster">Poster</option>',
      '<option value="mph" selected="">mph</option>',
      '<option value="km/h">km/h</option>',
      '<option value="" selected="">None</option>',
    ])
      expect(html).toContain(option);
  });
});
