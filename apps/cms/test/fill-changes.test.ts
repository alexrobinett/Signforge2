// What an update from a photo of today's menu would change (#264), as its review says it: each
// field's new value, a list's rows changed, added and removed, and the same rows on other spots.
import type { FieldDef } from '@signforge/contract';
import { describe, expect, it } from 'vitest';
import { alsoOn, fillChanges } from '../src/lib/fill-changes';
import type { SpotView, TemplateVersionView } from '../src/lib/spots';

const FIELDS: Record<string, FieldDef> = {
  title: { type: 'text', label: 'Title' },
  items: {
    type: 'list',
    label: 'Items',
    item: { name: { type: 'text', label: 'Name' }, price: { type: 'text', label: 'Price' }, link: { type: 'url', label: 'Link', default: '' } },
  },
};
const BEFORE = {
  title: 'Morning',
  items: [
    { name: 'Latte', price: '$4.50', link: 'https://cafe.example/latte' },
    { name: 'Mocha', price: '$5.00', link: '' },
    { name: 'Scone', price: '$3.00', link: '' },
  ],
};
const AFTER = {
  title: 'Morning',
  items: [
    { name: 'Latte', price: '$4.75', link: 'https://cafe.example/latte' },
    { name: 'Scone', price: '$3.00', link: '' },
    { name: 'Flat white', price: '$4.00', link: '' },
  ],
};

describe('fillChanges', () => {
  it('says which rows of a menu changed, which are new and which are gone, and nothing of what stayed', () => {
    expect(fillChanges(FIELDS, BEFORE, AFTER)).toEqual([
      {
        field: 'items',
        label: 'Items',
        kind: 'rows',
        changed: [{ name: 'Latte', key: 'latte', cells: [{ column: 'price', label: 'Price', before: '$4.50', after: '$4.75' }] }],
        added: ['Flat white · $4.00'],
        removed: ['Mocha · $5.00'],
      },
    ]);
  });

  it("says a field's new value, an empty one in words", () => {
    expect(fillChanges(FIELDS, { ...BEFORE, title: '' }, { ...BEFORE, title: 'Lunch' })).toEqual([
      { field: 'title', label: 'Title', kind: 'value', before: '(empty)', after: 'Lunch' },
    ]);
    expect(fillChanges(FIELDS, BEFORE, BEFORE)).toEqual([]);
  });

  it('matches a row whose name differs only in case and spacing, as the same item', () => {
    const after = { ...BEFORE, items: [{ ...BEFORE.items[0], name: ' latte ' }, ...BEFORE.items.slice(1)] };
    const [items] = fillChanges(FIELDS, BEFORE, after);
    expect(items).toMatchObject({ kind: 'rows', added: [], removed: [], changed: [{ name: 'Latte', cells: [{ label: 'Name' }] }] });
  });
});

describe('alsoOn', () => {
  const menu = { id: 'tpv_menu', manifest: { fields: FIELDS } } as unknown as TemplateVersionView;
  const spot = (id: string, name: string, data: Record<string, unknown>, bindings: Record<string, unknown> | null = null) =>
    ({ id, name, kind: 'template', templateVersionId: 'tpv_menu', data, bindings, version: 3 }) as unknown as SpotView;
  const lunch = spot('spt_lunch', 'Lunch menu', {
    title: 'Lunch',
    items: [
      { name: 'Soup', price: '$6', link: '' },
      { name: 'LATTE', price: '$4.50', link: 'https://x.example' },
    ],
  });

  it("finds the changed latte on the lunch menu, and changes only its price there, keeping that spot's other columns", () => {
    const changes = fillChanges(FIELDS, BEFORE, AFTER);
    const found = alsoOn('spt_breakfast', FIELDS, AFTER, changes, [lunch, spot('spt_breakfast', 'Breakfast', BEFORE)], new Map([['tpv_menu', menu]]));
    expect(found).toEqual([
      {
        spotId: 'spt_lunch',
        name: 'Lunch menu',
        items: ['LATTE'],
        version: 3,
        before: lunch.data,
        data: {
          title: 'Lunch',
          items: [
            { name: 'Soup', price: '$6', link: '' },
            { name: 'LATTE', price: '$4.75', link: 'https://x.example' },
          ],
        },
      },
    ]);
  });

  it('copies only what changed: a column the latte has on this menu but did not change stays as the other menu has it', () => {
    const tagged = {
      ...FIELDS,
      items: { ...FIELDS.items, item: { ...(FIELDS.items as { item: object }).item, tag: { type: 'select', label: 'Tag', options: ['', 'Popular'] } } },
    } as Record<string, FieldDef>;
    const was = { items: [{ name: 'Latte', price: '$4.50', tag: 'Popular' }] };
    const now = { items: [{ name: 'Latte', price: '$4.75', tag: 'Popular' }] };
    const plain = spot('spt_lunch', 'Lunch menu', { items: [{ name: 'Latte', price: '$4.50', tag: '' }] });
    const found = alsoOn('spt_breakfast', tagged, now, fillChanges(tagged, was, now), [plain], new Map([['tpv_menu', menu]]));
    expect(found[0]?.data).toEqual({ items: [{ name: 'Latte', price: '$4.75', tag: '' }] });
  });

  it('offers nothing for rows only added or removed, nor a list its data source fills', () => {
    const added = { ...BEFORE, items: [...BEFORE.items, { name: 'Tea', price: '$2', link: '' }] };
    expect(alsoOn('spt_breakfast', FIELDS, added, fillChanges(FIELDS, BEFORE, added), [lunch], new Map([['tpv_menu', menu]]))).toEqual([]);
    const bound = spot('spt_bound', 'Bound', lunch.data ?? {}, { items: { dataSourceId: 'dsrc', path: 'rows' } });
    expect(alsoOn('spt_breakfast', FIELDS, AFTER, fillChanges(FIELDS, BEFORE, AFTER), [bound], new Map([['tpv_menu', menu]]))).toEqual([]);
  });
});
