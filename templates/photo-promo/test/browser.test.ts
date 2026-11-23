import { IMAGE_SAMPLE_CELL, type Orientation } from '@signforge/contract';
import { brandColourTests, host, spotData, useTemplate, type BrandSpot } from '@signforge/template-test';

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
  onBackdrop: ['.eyebrow'],
  sameWithSample: '.eyebrow',
});
