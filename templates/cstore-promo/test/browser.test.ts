import { expect, it } from 'vitest';
import { brandColourTests, DEMO_KIT, largestImageBox, motionContract, screenFrame, useTemplate } from '@signforge/template-test';

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

// D's motion (docs/template-spec.md, Motion), read by seeking: the copy, three products and the badge.
for (const orientation of ['landscape', 'portrait'] as const)
  it(`moves as D does, ${orientation}`, async () => {
    const k = await screenFrame(t(), orientation, { imageLeft: '#f00', imageCenter: '#0f0', imageRight: '#00f' });
    const durationMs = 11_000;
    const f = await k.play({ disclaimer: 'While stocks last' }, undefined, durationMs);
    expect(await motionContract(f, durationMs)).toEqual([]);
  });

// #224: with it, a portrait screen gets the landscape rendition, which must never be drawn larger than it is.
it('draws each product within the portraitBox it declares, over the whole spot', async () => {
  const { manifest } = t();
  const k = await screenFrame(t(), 'portrait', { imageLeft: '#f00', imageCenter: '#0f0', imageRight: '#00f' });
  const found: string[] = [];
  for (const data of [{}, { disclaimer: 'While stocks last', detail: 'All sizes' }]) {
    const f = await k.play(data);
    for (const field of ['imageLeft', 'imageCenter', 'imageRight']) {
      const def = manifest.fields[field];
      const box = def?.type === 'image' ? def.portraitBox : undefined;
      const drawn = await largestImageBox(f, `[data-sf-src="${field}"]`, manifest.duration.defaultMs);
      if (!box || drawn.w > box.w || drawn.h > box.h) found.push(`${field} drawn up to ${drawn.w}x${drawn.h}`);
    }
  }
  expect(found).toEqual([]);
}, 120_000);

// The board's c-store promo (#news-design): no glass panel, no gradient text, no spinning ring, still bottles once they
// have arrived, and the points disc in the kit's accent, the one accent.
for (const orientation of ['landscape', 'portrait'] as const)
  it(`has no panel, gradient text or ring, and still bottles; the disc is the accent, ${orientation}`, async () => {
    const k = await screenFrame(t(), orientation, { imageLeft: '#f00', imageCenter: '#0f0', imageRight: '#00f' });
    const seen = await (await k.play({}, { colors: { ...DEMO_KIT, accent: '#ffd84a' }, shape: 'soft', fonts: {} })).evaluate(() => {
      for (const a of document.getAnimations()) a.currentTime = 3000;
      const style = (sel: string, pseudo?: string) => getComputedStyle(document.querySelector(sel)!, pseudo);
      return {
        panel: style('.copy', '::before').content,
        product: style('.l2').webkitTextFillColor === style('.l2').color && style('.l2').backgroundImage === 'none',
        ring: document.querySelectorAll('.badge svg').length,
        disc: [style('.badge .disc').backgroundColor, style('.badge .disc').boxShadow],
        moving: document.getAnimations().filter((a) => a.playState === 'running' && a.effect!.getComputedTiming().progress !== null).length,
      };
    });
    expect(seen).toEqual({ panel: 'none', product: true, ring: 0, disc: ['rgb(255, 216, 74)', 'none'], moving: 0 });
  });
