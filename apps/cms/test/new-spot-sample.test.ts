// A new spot from the New spot dialog (#360): named after its template, and started with its
// sample copy (what its thumbnail shows), which the editor marks until it is replaced.
import { readdirSync, readFileSync } from 'node:fs';
import { draftCheck, sampleData } from '@signforge/compiler/draft';
import { type FieldDef, type LiveSourceDef, type TemplateManifest, validateSpotData } from '@signforge/contract';
import { describe, expect, it } from 'vitest';
import { nextName, sampleWords } from '../src/lib/spots';

const root = new URL('../../../templates/', import.meta.url);
const templates = readdirSync(root).map((d): TemplateManifest => JSON.parse(readFileSync(new URL(`${d}/template.json`, root), 'utf8')));

describe('a new spot’s sample data', () => {
  it.each(templates.map((t) => [t.id, t] as const))('%s: saves and passes the publish’s checks, but for a photo or a date to choose', (_, t) => {
    const data = sampleData(t);
    const checked = draftCheck(t.fields, { data, assets: {}, bindings: {} });
    expect(validateSpotData(checked.fields, checked.data, {}, {})).toEqual([]);
  });

  it('holds the template’s own copy, else a text’s label, and a list only its own rows', () => {
    const fields: Record<string, FieldDef> = {
      headline: { type: 'text', label: 'Headline', default: 'Pier 9 opens on Monday' },
      note: { type: 'text', label: 'A note that is longer than it may be', maxLength: 6 },
      greeting: { type: 'text', label: 'Greeting (empty for good morning)', default: '' },
      items: { type: 'list', label: 'Items', maxItems: 2, item: { name: { type: 'text', label: 'Name' }, price: { type: 'number', label: 'Price', min: 1 } } },
      events: { type: 'list', label: 'Events', item: { at: { type: 'datetime', label: 'Starts' } } },
    };
    expect(sampleData({ fields })).toEqual({
      headline: 'Pier 9 opens on Monday',
      note: 'A note',
      greeting: '',
      items: [],
      events: [],
    });
  });
});

it('leaves a live field’s fallback as a new spot starts it: screens show it when the source is down, unseen in the form (#253)', () => {
  const fields: Record<string, FieldDef> = {
    title: { type: 'text', label: 'Title', default: 'Headlines' },
    items: { type: 'list', label: 'Headlines', item: { title: { type: 'text', label: 'Title' } }, default: [{ title: 'Pier 9 opens' }] },
  };
  const live: LiveSourceDef = { source: 'rss', fields: { items: 'items' } };
  expect(sampleData({ fields, live })).toEqual({ title: 'Headlines', items: [] });
});

describe('a new spot’s name', () => {
  it('is its template’s, then the first free number after it', () => {
    expect(nextName('Announcement', [])).toBe('Announcement');
    expect(nextName('Announcement', [{ name: 'Announcement' }])).toBe('Announcement 2');
    expect(nextName('Announcement', [{ name: 'Announcement' }, { name: 'Announcement 2' }, { name: 'Announcement 4' }])).toBe('Announcement 3');
  });

  it('is trimmed, and cut so its number still fits in 100 characters', () => {
    expect(nextName('Announcement ', [])).toBe('Announcement');
    expect(nextName(' Menu  ', [{ name: 'Menu' }])).toBe('Menu 2');
    const long = 'x'.repeat(99);
    expect(nextName(long, [])).toBe(long);
    const second = nextName(long, [{ name: long }]);
    expect(second).toBe(`${'x'.repeat(98)} 2`);
    expect(second).toHaveLength(100);
    expect(nextName('y'.repeat(120), [])).toHaveLength(100);
  });
});

describe('what Publish says of sample text', () => {
  it('names the fields and each spot, even one alone', () => {
    expect(sampleWords([{ name: 'Pier', labels: ['Headline', 'Body'] }])).toBe('In Pier, Headline and Body still have sample text.');
    expect(
      sampleWords([
        { name: 'Pier', labels: ['Headline'] },
        { name: 'Alert', labels: ['Headline', 'Issued by', 'Instructions'] },
      ]),
    ).toBe('In Pier, Headline still has sample text. In Alert, Headline, Issued by and Instructions still have sample text.');
  });
});
