import { expect, it } from 'vitest';
import { brandColourTests, motionContract, screenFrame, useTemplate } from '@signforge/template-test';

const t = useTemplate(new URL('..', import.meta.url), {
  a: { theme: 'light', items: Array.from({ length: 7 }, (_, i) => ({ name: `Dish ${i}`, description: 'Good', price: `$${i}`, tag: i ? '' : 'New' })) },
  b: {
    theme: 'dark',
    items: [
      { name: 'Soup', description: 'Hot', price: '$4', tag: '' },
      { name: 'Bread', description: '', price: '$2', tag: 'V' },
    ],
  },
});

const menu = { items: [{ name: 'Soup', description: 'Hot', price: '$4', tag: 'New' }] };
brandColourTests(t, {
  spots: (accent) => [[{ accent, ...menu }], [{ accent, ...menu, theme: 'light' }]],
  onFill: [['.items .tag', '.items .tag', 4.5]],
  onBackdrop: ['.price'],
});

// D's motion (docs/template-spec.md, Motion), read by seeking: a header, seven dishes, one tagged, and a footnote.
for (const orientation of ['landscape', 'portrait'] as const)
  it(`moves as D does, ${orientation}`, async () => {
    const k = await screenFrame(t(), orientation, {});
    const durationMs = 11_000;
    const items = Array.from({ length: 7 }, (_, i) => ({ name: `Dish ${i}`, description: 'Good', price: `$${i}`, tag: i ? '' : 'New' }));
    const f = await k.play({ subtitle: 'Lunch', items, footnote: 'Ask about allergens' }, undefined, durationMs);
    expect(await motionContract(f, durationMs)).toEqual([]);
  });
