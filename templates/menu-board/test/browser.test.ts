import { expect, it } from 'vitest';
import { brandColourTests, DEMO_KIT, motionContract, screenFrame, useTemplate } from '@signforge/template-test';

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
  onBackdrop: ['.items .tag'],
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

// The board's menu board (#news-design): the header hangs top-left on one baseline, rows are ruled, not cards, prices
// take the text colour and tags are accent words, not pills.
for (const orientation of ['landscape', 'portrait'] as const)
  it(`hangs the header, rules the rows and keeps the accent to the tags, ${orientation}`, async () => {
    const k = await screenFrame(t(), orientation, {});
    const items = Array.from({ length: 7 }, (_, i) => ({ name: `Dish ${i}`, description: 'Good', price: `$${i}`, tag: i ? '' : 'New' }));
    const f = await k.play({ title: 'Coffee bar', subtitle: 'Made to order', items }, { colors: DEMO_KIT, shape: 'soft', fonts: {} });
    const seen = await f.evaluate(() => {
      for (const a of document.getAnimations()) a.currentTime = 3000;
      const style = (sel: string) => getComputedStyle(document.querySelector(sel)!);
      const [title, subtitle] = [document.querySelector('h1')!.getBoundingClientRect(), document.querySelector('.subtitle')!.getBoundingClientRect()];
      return {
        left: Math.round(title.left) === Math.round(document.querySelector('.items')!.getBoundingClientRect().left),
        beside: subtitle.left > title.right,
        card: style('.item').backgroundColor,
        rule: style('.item').borderBottomStyle,
        price: style('.price').color === style('.name').color,
        pill: [style('.tag').backgroundColor, style('.tag').textTransform],
      };
    });
    expect(seen).toEqual({ left: true, beside: true, card: 'rgba(0, 0, 0, 0)', rule: 'solid', price: true, pill: ['rgba(0, 0, 0, 0)', 'none'] });
  });
