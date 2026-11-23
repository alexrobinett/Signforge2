import { brandColourTests, useTemplate } from '@signforge/template-test';

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
