import { defineTemplate, type TemplateContext } from '@signforge/template-sdk';
import { IMAGE_SAMPLE_CELL, readableOver, sampleAsset } from '@signforge/template-sdk/backdrop';
import { readableOn } from '@signforge/template-sdk/contrast';

// Text and images are bound by the SDK from the data-sf attributes in index.html.
defineTemplate({
  async prepare(ctx) {
    // A kit may set an on-primary by hand that does not read on its primary (the brand tools only
    // warn); the price tag's text then takes black or white. With no kit the CSS fallbacks are a pair.
    const kit = ctx.root.style;
    const primary = kit.getPropertyValue('--sf-primary');
    if (primary) kit.setProperty('--sf-on-primary', readableOn(primary, kit.getPropertyValue('--sf-on-primary')));
    // The eyebrow is the text colour over the photo, seen through a shade of the background: measured
    // there, it is the text colour where that reads, else black or white. A photo with light and dark
    // under it can leave none reading, and the eyebrow then sits on a fill of the background.
    const css = getComputedStyle(ctx.root);
    const bg = css.getPropertyValue('--bg');
    const ink = css.getPropertyValue('--text');
    const eyebrow = document.querySelector<HTMLElement>('.eyebrow')!;
    // Unpainted until prepare returns: a frame that paints the photo has it decoded for the screen
    // first, and the SDK's decode before ready then waits behind that one (on the Pi, 80 ms more).
    const img = document.querySelector<HTMLImageElement>('.photo img')!;
    img.style.visibility = 'hidden';
    const page = document.body;
    const { pixels, lightest } = await backdrop(ctx, eyebrow, img, bg);
    // New data while the backdrop was measured: the SDK put a fresh copy of the loaded body in place
    // and inits again. Rejecting stops this prepare there, and the SDK drops a superseded prepare's error.
    if (document.body !== page) throw new Error('new data replaced this prepare');
    img.style.visibility = '';
    const over = readableOver(pixels, ink, { large: true, lightest });
    if (!over) eyebrow.classList.add('scrim');
    kit.setProperty('--eyebrow-ink', over ?? readableOn(bg, ink, { large: true }));
  },
});

/**
 * What is behind the eyebrow's text: the photo under the text's box, wherever the push-in moves it
 * during the spot, under the shade as it is at the box's top and at its bottom (a text over a
 * gradient is measured at both ends). One canvas read.
 *
 * From the photo's sample when init carries one: each cell's darkest pixel in `pixels` and its
 * lightest in `lightest`, for every cell the box touches. It does not wait for the photo: drawing the
 * photo decodes it again on the main thread, 70 ms or more of a Pi's prepare, and waiting for it to
 * load holds the SDK's decode back by the rest of the measuring. Without a sample (a photo uploaded
 * before samples, or with transparent pixels) or for a photo enlarged more than twice, the photo,
 * once loaded, one pixel per pixel the screen paints it at: fewer average away its darkest and
 * lightest detail, which the screen shows.
 */
async function backdrop(
  ctx: TemplateContext,
  eyebrow: HTMLElement,
  img: HTMLImageElement,
  bg: string,
): Promise<{ pixels: Uint8ClampedArray; lightest?: Uint8ClampedArray }> {
  // The box is the text's, so it is measured in the template's font, not a fallback.
  await document.fonts.ready;
  // The rise-in moves the eyebrow only up and down, so the text's left and width are where it
  // rests; its top and height come from the layout, which no animation moves.
  const text = document.createRange();
  text.selectNodeContents(eyebrow);
  const { left, width } = text.getBoundingClientRect();
  const top = document.querySelector('.copy')!.getBoundingClientRect().top + eyebrow.offsetTop;
  const height = eyebrow.offsetHeight;

  const { width: vw, height: vh } = ctx.viewport;
  const push = Number(getComputedStyle(img.parentElement!).getPropertyValue('--push'));
  /**
   * The part of a `nw`x`nh` photo under the box, in its pixels, wherever the push-in takes it, and
   * the scale the screen paints it at: object-fit: cover, then scaled about the centre from 1 to
   * `push` (`at`: the photo's pixel under a point on screen, along one axis, at scale `s`).
   */
  const under = (nw: number, nh: number) => {
    const scale = Math.max(vw / nw, vh / nh);
    const at = (p: number, size: number, natural: number, s: number) => (size / 2 + (p - size / 2) / s - (size - natural * scale) / 2) / scale;
    return {
      x: Math.min(at(left, vw, nw, 1), at(left, vw, nw, push)),
      y: Math.min(at(top, vh, nh, 1), at(top, vh, nh, push)),
      x1: Math.max(at(left + width, vw, nw, 1), at(left + width, vw, nw, push)),
      y1: Math.max(at(top + height, vh, nh, 1), at(top + height, vh, nh, push)),
      scale,
    };
  };
  const shade = getComputedStyle(document.querySelector('.shade')!);
  const stop = (name: string) => Number.parseFloat(shade.getPropertyValue(name)) / 100;
  const [a0, a1, at1, at2] = [stop('--shade-0'), stop('--shade-1'), stop('--shade-1-at'), stop('--shade-2-at')];
  /** The shade's opacity at `y` on screen; its gradient runs from the bottom. */
  const opacity = (y: number) => {
    const d = 1 - y / ctx.viewport.height;
    return d <= at1 ? a0 + ((a1 - a0) * d) / at1 : d < at2 ? (a1 * (at2 - d)) / (at2 - at1) : 0;
  };

  const url = ctx.assets[sampleAsset('photo')];
  if (url && width) {
    const sample = new Image();
    sample.src = url;
    // The server checks a sample's header, not its data: one that does not decode leaves the photo.
    const decoded = await sample.decode().then(
      () => true,
      () => false,
    );
    if (decoded) {
      // The photo's size is known from its sample to the cell, before the photo loads: the cells
      // under the box at every size it can be. A photo painted at more than twice its size has a
      // quarter of the screen's pixels or fewer, quick to decode, and a cell would stand for more
      // than 32 px of screen: it is measured itself.
      const k = IMAGE_SAMPLE_CELL;
      const [cols, rows] = [sample.naturalWidth, sample.naturalHeight / 2];
      const sizes = [cols * k - k + 1, cols * k].flatMap((nw) => [rows * k - k + 1, rows * k].map((nh) => under(nw, nh)));
      if (sizes.every((r) => r.scale <= 2)) return cells(sample, sizes, cols, rows, opacity(top), opacity(top + height), bg);
    }
  }

  // drawImage decodes the photo for the canvas itself: awaiting img.decode() first decoded it twice
  // (on the Pi, 100 ms more per prepare). A photo that does not load is not shown, and the copy then
  // sits on the background. (Measured from its sample, the photo is taken to load: both are files
  // the screen has verified.)
  if (img.src && !img.complete)
    await new Promise((loaded) => {
      img.addEventListener('load', loaded, { once: true });
      img.addEventListener('error', loaded, { once: true });
    });
  const region = img.naturalWidth && width ? under(img.naturalWidth, img.naturalHeight) : undefined;
  const photo = region && { x: region.x, y: region.y, w: region.x1 - region.x, h: region.y1 - region.y, scale: region.scale };

  // At the push-in's start the screen paints the photo at `scale`, and larger after: so many samples.
  const w = photo ? Math.ceil(photo.w * photo.scale) : 1;
  const h = photo ? Math.ceil(photo.h * photo.scale) : 1;
  // Read back and never shown: `willReadFrequently` keeps it in memory, with no GPU readback.
  const g = new OffscreenCanvas(w, 2 * h).getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = bg;
  g.fillRect(0, 0, w, 2 * h);
  if (photo) {
    g.drawImage(img, photo.x, photo.y, photo.w, photo.h, 0, 0, w, h);
    g.drawImage(img, photo.x, photo.y, photo.w, photo.h, 0, h, w, h);
  }

  g.globalAlpha = opacity(top);
  g.fillRect(0, 0, w, h);
  g.globalAlpha = opacity(top + height);
  g.fillRect(0, h, w, h);
  return { pixels: g.getImageData(0, 0, w, 2 * h).data };
}

/**
 * The cells of a photo's sample under every region in `regions` (in the photo's pixels), from the
 * sample's darkest half and its lightest, under the shade at `top` and `bottom` opacity: darkest at
 * the top, darkest at the bottom, lightest at the top, lightest at the bottom, one block of rows below
 * the other, read once. The regions can reach past the photo's edge by less than a cell, as its size
 * is known to the cell: no cell outside the sample is read.
 */
function cells(
  sample: HTMLImageElement,
  regions: { x: number; y: number; x1: number; y1: number }[],
  cols: number,
  rows: number,
  top: number,
  bottom: number,
  bg: string,
): { pixels: Uint8ClampedArray; lightest: Uint8ClampedArray } {
  const k = IMAGE_SAMPLE_CELL;
  const x = Math.max(0, Math.floor(Math.min(...regions.map((r) => r.x)) / k));
  const y = Math.max(0, Math.floor(Math.min(...regions.map((r) => r.y)) / k));
  const w = Math.min(cols, Math.ceil(Math.max(...regions.map((r) => r.x1)) / k)) - x;
  const h = Math.min(rows, Math.ceil(Math.max(...regions.map((r) => r.y1)) / k)) - y;
  const g = new OffscreenCanvas(w, 4 * h).getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingEnabled = false;
  g.fillStyle = bg;
  for (const i of [0, 1, 2, 3]) {
    g.globalAlpha = 1;
    g.drawImage(sample, x, y + (i < 2 ? 0 : rows), w, h, 0, i * h, w, h);
    g.globalAlpha = i % 2 ? bottom : top;
    g.fillRect(0, i * h, w, h);
  }
  const data = g.getImageData(0, 0, w, 4 * h).data;
  return { pixels: data.subarray(0, data.length / 2), lightest: data.subarray(data.length / 2) };
}
