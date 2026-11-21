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
    // The eyebrow is the accent over the photo, seen through a shade of the background: measured
    // there, it is the accent where that reads, else black or white. A photo with light and dark
    // under it can leave none reading, and the eyebrow then sits on a fill of the background.
    const css = getComputedStyle(ctx.root);
    const bg = css.getPropertyValue('--bg');
    const accent = css.getPropertyValue('--accent');
    const eyebrow = document.querySelector<HTMLElement>('.eyebrow')!;
    const { pixels, lightest } = await backdrop(ctx, eyebrow, bg);
    const over = readableOver(pixels, accent, { large: true, lightest });
    if (!over) eyebrow.classList.add('scrim');
    kit.setProperty('--accent-text', over ?? readableOn(bg, accent, { large: true }));
  },
});

/**
 * What is behind the eyebrow's text: the photo under the text's box, wherever the push-in moves it
 * during the spot, under the shade as it is at the box's top and at its bottom (a text over a
 * gradient is measured at both ends). One canvas read.
 *
 * From the photo's sample when init carries one: each cell's darkest pixel in `pixels` and its
 * lightest in `lightest`, for every cell the box touches. Drawing the photo itself decodes it again
 * on the main thread, 100 ms or more of a Pi's prepare. Without a sample (a photo uploaded before
 * samples, or with transparent pixels) or a photo enlarged more than twice, the photo, one pixel
 * per pixel the screen paints it at: fewer average away its darkest and lightest detail, which the
 * screen shows.
 */
async function backdrop(ctx: TemplateContext, eyebrow: HTMLElement, bg: string): Promise<{ pixels: Uint8ClampedArray; lightest?: Uint8ClampedArray }> {
  // The box is the text's, so it is measured in the template's font, not a fallback.
  await document.fonts.ready;
  // The rise-in moves the eyebrow only up and down, so the text's left and width are where it
  // rests; its top and height come from the layout, which no animation moves.
  const text = document.createRange();
  text.selectNodeContents(eyebrow);
  const { left, width } = text.getBoundingClientRect();
  const top = document.querySelector('.copy')!.getBoundingClientRect().top + eyebrow.offsetTop;
  const height = eyebrow.offsetHeight;

  const img = document.querySelector<HTMLImageElement>('.photo img')!;
  // drawImage decodes the photo for the canvas itself: awaiting img.decode() first decoded it twice
  // (on the Pi, 100 ms more per prepare). A photo that does not load is not shown, and the copy then
  // sits on the background.
  if (img.src && !img.complete)
    await new Promise((loaded) => {
      img.addEventListener('load', loaded, { once: true });
      img.addEventListener('error', loaded, { once: true });
    });
  let photo: { x: number; y: number; w: number; h: number; scale: number } | undefined;
  if (img.naturalWidth && width) {
    const { width: vw, height: vh } = ctx.viewport;
    const push = Number(getComputedStyle(img.parentElement!).getPropertyValue('--push'));
    // object-fit: cover, then scaled about the centre from 1 to `push`: the photo's pixel under a
    // point on screen, along one axis, at scale `s`.
    const scale = Math.max(vw / img.naturalWidth, vh / img.naturalHeight);
    const at = (p: number, size: number, natural: number, s: number) => (size / 2 + (p - size / 2) / s - (size - natural * scale) / 2) / scale;
    const x = Math.min(at(left, vw, img.naturalWidth, 1), at(left, vw, img.naturalWidth, push));
    const y = Math.min(at(top, vh, img.naturalHeight, 1), at(top, vh, img.naturalHeight, push));
    const x1 = Math.max(at(left + width, vw, img.naturalWidth, 1), at(left + width, vw, img.naturalWidth, push));
    const y1 = Math.max(at(top + height, vh, img.naturalHeight, 1), at(top + height, vh, img.naturalHeight, push));
    photo = { x, y, w: x1 - x, h: y1 - y, scale };
  }
  const shade = getComputedStyle(document.querySelector('.shade')!);
  const stop = (name: string) => Number.parseFloat(shade.getPropertyValue(name)) / 100;
  const [a0, a1, at1, at2] = [stop('--shade-0'), stop('--shade-1'), stop('--shade-1-at'), stop('--shade-2-at')];
  /** The shade's opacity at `y` on screen; its gradient runs from the bottom. */
  const opacity = (y: number) => {
    const d = 1 - y / ctx.viewport.height;
    return d <= at1 ? a0 + ((a1 - a0) * d) / at1 : d < at2 ? (a1 * (at2 - d)) / (at2 - at1) : 0;
  };

  // A photo painted at more than twice its size has a quarter of the screen's pixels or fewer, quick
  // to decode, and a cell of its sample would stand for more than 32 px of screen: measure it itself.
  const url = ctx.assets[sampleAsset('photo')];
  if (photo && url && photo.scale <= 2) {
    const sample = new Image();
    sample.src = url;
    await sample.decode();
    // The cells under the box, from the sample's darkest half and its lightest: darkest at the box's
    // top, darkest at its bottom, lightest at its top, lightest at its bottom, one row of each below the other.
    const k = IMAGE_SAMPLE_CELL;
    const [x, y] = [Math.floor(photo.x / k), Math.floor(photo.y / k)];
    const w = Math.ceil((photo.x + photo.w) / k) - x;
    const h = Math.ceil((photo.y + photo.h) / k) - y;
    const g = new OffscreenCanvas(w, 4 * h).getContext('2d', { willReadFrequently: true })!;
    g.imageSmoothingEnabled = false;
    g.fillStyle = bg;
    for (const i of [0, 1, 2, 3]) {
      g.globalAlpha = 1;
      g.drawImage(sample, x, y + (i < 2 ? 0 : sample.naturalHeight / 2), w, h, 0, i * h, w, h);
      g.globalAlpha = opacity(i % 2 ? top + height : top);
      g.fillRect(0, i * h, w, h);
    }
    const data = g.getImageData(0, 0, w, 4 * h).data;
    return { pixels: data.subarray(0, data.length / 2), lightest: data.subarray(data.length / 2) };
  }

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
