import { IMAGE_SAMPLE_CELL, type FrameTheme, type Orientation } from '@signforge/contract';
import { describe, expect, it } from 'vitest';
import { brandColourTests, DEMO_KIT, host, motionContract, screenFrame, spotData, useTemplate, type BrandSpot } from '@signforge/template-test';

const t = useTemplate(new URL('..', import.meta.url), {
  a: { body: 'Picked this morning' },
  b: { headline: 'Two for one' },
  assetsA: { photo: '#963' },
  assetsB: { photo: '#369' },
});

const blocks = new Map<Orientation, Promise<string[]>>();
/**
 * Two 960x540 photos for `orientation`, white with a black block where photo-promo's eyebrow is
 * measured and black with a white one: the photo under the text through the push-in, mapped as
 * main.ts maps it, and three cells more on each side, as the sample knows the photo's size only to
 * the cell.
 */
function blockPhotos(orientation: Orientation): Promise<string[]> {
  const made =
    blocks.get(orientation) ??
    (async () => {
      const hst = await host(orientation);
      await hst.open('fresh', t().html);
      await hst.init('fresh', spotData(t().manifest, {}), { photo: '960x540: #808080' });
      await hst.waitFor('fresh', 'ready', 1);
      const [x, y, x1, y1] = await hst.page
        .mainFrame()
        .childFrames()[0]!
        .evaluate(() => {
          const eyebrow = document.querySelector<HTMLElement>('.eyebrow')!;
          const text = document.createRange();
          text.selectNodeContents(eyebrow);
          const { left, width } = text.getBoundingClientRect();
          const top = document.querySelector('.copy')!.getBoundingClientRect().top + eyebrow.offsetTop;
          const height = eyebrow.offsetHeight;
          const push = Number(getComputedStyle(document.querySelector('.photo')!).getPropertyValue('--push'));
          const [vw, vh, nw, nh] = [innerWidth, innerHeight, 960, 540];
          const scale = Math.max(vw / nw, vh / nh);
          const at = (p: number, size: number, natural: number, s: number) => (size / 2 + (p - size / 2) / s - (size - natural * scale) / 2) / scale;
          return [
            Math.min(at(left, vw, nw, 1), at(left, vw, nw, push)),
            Math.min(at(top, vh, nh, 1), at(top, vh, nh, push)),
            Math.max(at(left + width, vw, nw, 1), at(left + width, vw, nw, push)),
            Math.max(at(top + height, vh, nh, 1), at(top + height, vh, nh, push)),
          ];
        });
      const m = 3 * IMAGE_SAMPLE_CELL;
      const rect = [Math.floor(x!) - m, Math.floor(y!) - m, Math.ceil(x1! - x!) + 2 * m, Math.ceil(y1! - y!) + 2 * m].join(',');
      return [`960x540: #ffffff; #000000 ${rect}`, `960x540: #000000; #ffffff ${rect}`];
    })();
  blocks.set(orientation, made);
  return made;
}

brandColourTests(t, {
  // The copy sits on a shade of the kit's background over the photo, whatever the photo is: light,
  // dark, mid-tone, or light and dark under the same text, in broad stripes and in stripes 1 px
  // wide at the screen's scale, which a photo measured at less than its painted detail averages
  // to grey. Each with the photo's sample, which photo-promo reads in place of the photo, and
  // without one, as a photo uploaded before samples is.
  // Photos painted at twice their size or less are measured from their sample, and the blocks
  // only from the cells under the eyebrow: any other cells give another answer.
  spots: async (_, orientation) => {
    const blocks = await blockPhotos(orientation);
    return [
      ...['#ffffff', '#000000', '#808080', '#000000 #ffffff', '960x540: #000000 #ffffff', ...blocks].flatMap((photo): BrandSpot[] => [
        [{}, photo, true],
        [{}, photo, false],
      ]),
      // A sample that does not decode: the photo is measured instead.
      [{}, blocks[0]!, 'broken'],
    ];
  },
  onFill: [['.tag', '.tag', 4.5]],
  onBackdrop: [],
  textColourOnBackdrop: ['.eyebrow'],
  sameWithSample: '.eyebrow',
});

// The SDK restores the document and inits again on new data, while the old prepare may still be
// measuring the eyebrow's backdrop. Here the first prepare is held at its first wait until the new
// data has played its own prepare: resuming must not set the eyebrow's colour on the new document
// (#308). The old data's kit has green text and the new data's none, so the old prepare's eyebrow
// colour (green, or black on its scrim) is never the new one's (the default white).
describe('photo-promo (#308)', () => {
  it('a prepare that new data replaced, resuming while it measures, leaves the new document as a fresh load', async () => {
    const hst = await host('landscape', true);
    const a = spotData(t().manifest, { body: 'Picked this morning' });
    const b = spotData(t().manifest, { headline: 'Two for one' });
    const green: FrameTheme = { colors: { ...DEMO_KIT, text: '#22c55e' }, shape: 'soft', fonts: {} };
    await hst.open('fresh', t().html);
    await hst.init('fresh', b, { photo: '#000000' }, undefined, undefined, true);
    await hst.waitFor('fresh', 'ready', 1);
    const fresh = await hst.dom('fresh');
    for (const [name, index] of [
      ['reset', 1],
      ['again', 2],
    ] as const) {
      await hst.open(name, t().html);
      const f = hst.page.mainFrame().childFrames()[index]!;
      // The first read of `document.fonts.ready` is the first prepare's: it waits there until the
      // test lets it go, and says when it has got there. The backdrop's last step is a canvas read.
      await f.evaluate(() => {
        const w = window as unknown as { held: Promise<void>; release: () => void; read: () => Promise<void> };
        const ready = Object.getOwnPropertyDescriptor(FontFaceSet.prototype, 'ready')!.get!;
        const gate = new Promise<void>((r) => (w.release = r));
        let arrived: () => void = () => {};
        w.held = new Promise((r) => (arrived = r));
        let reads = 0;
        Object.defineProperty(document.fonts, 'ready', {
          get(this: FontFaceSet) {
            if (reads++) return ready.call(this);
            arrived();
            return gate.then(() => ready.call(this));
          },
        });
        const getImageData = OffscreenCanvasRenderingContext2D.prototype.getImageData;
        let onRead: () => void = () => {};
        w.read = () => new Promise((r) => (onRead = r));
        OffscreenCanvasRenderingContext2D.prototype.getImageData = function (this: OffscreenCanvasRenderingContext2D, ...args) {
          onRead();
          return getImageData.apply(this, args);
        };
      });
      await hst.init(name, a, { photo: '#ffffff' }, undefined, green, true);
      await f.evaluate(() => (window as unknown as { held: Promise<void> }).held);
      if (name === 'reset') {
        await hst.post(name, 'reset');
        await hst.waitFor(name, 'loaded', 2);
      }
      await hst.init(name, b, { photo: '#000000' }, undefined, undefined, true);
      await hst.waitFor(name, 'ready', 1);
      // Let the first prepare go until its backdrop's canvas read, then wait a task: what it does
      // next runs in microtasks before it.
      await f.evaluate(async () => {
        const w = window as unknown as { release: () => void; read: () => Promise<void> };
        const read = w.read();
        w.release();
        await read;
        await new Promise((r) => setTimeout(r));
      });
      expect(await hst.dom(name), name).toBe(fresh);
    }
  });
});

// D's motion (docs/template-spec.md, Motion), read by seeking: the photo's push-in, the copy and the price tag.
for (const orientation of ['landscape', 'portrait'] as const)
  it(`moves as D does, ${orientation}`, async () => {
    const k = await screenFrame(t(), orientation, { photo: '#963' });
    const durationMs = 11_000;
    const f = await k.play({ body: 'Picked this morning' }, undefined, durationMs);
    expect(await motionContract(f, durationMs)).toEqual([]);
  });

// The board's photo promo (#news-design): the price is a flat tag, not a floating disc with a shadow.
for (const orientation of ['landscape', 'portrait'] as const)
  it(`shows the price as a flat tag, ${orientation}`, async () => {
    const k = await screenFrame(t(), orientation, { photo: '#963' });
    const tag = await (await k.play({}, { colors: DEMO_KIT, shape: 'round', fonts: {} })).evaluate(() => {
      const el = document.querySelector('.tag')!;
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return {
        shadow: style.boxShadow,
        radius: Number.parseFloat(style.borderTopLeftRadius) / (Math.min(innerWidth, innerHeight) / 100),
        wider: box.width > box.height,
      };
    });
    expect(tag.shadow).toBe('none');
    expect(tag.radius).toBeLessThanOrEqual(2);
    expect(tag.wider).toBe(true);
  });
