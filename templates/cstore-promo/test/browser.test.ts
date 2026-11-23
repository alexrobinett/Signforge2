import { brandColourTests, useTemplate } from '@signforge/template-test';

const t = useTemplate(new URL('..', import.meta.url), {
  a: { promo: 'Buy any 3', product: 'Energy', price: '6' },
  b: { detail: 'All sizes' },
  assetsA: { imageLeft: '#f00', imageCenter: '#0f0', imageRight: '#00f' },
  assetsB: { imageLeft: '#ff0', imageCenter: '#0ff', imageRight: '#f0f' },
});

// Text on a fill: 4.5:1 as axe checks it, 3:1 for the large points figure.
brandColourTests(t, {
  spots: () => [[{}]],
  onFill: [
    ['.badge small', '.badge .disc', 4.5],
    ['.badge b', '.badge .disc', 3],
  ],
  onBackdrop: ['.l1'],
});
