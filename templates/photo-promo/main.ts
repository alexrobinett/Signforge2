import { defineTemplate, type TemplateContext } from '@signforge/template-sdk';
import { readableOver } from '@signforge/template-sdk/backdrop';
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
    const over = readableOver(await backdrop(ctx, eyebrow, bg), accent, { large: true });
    if (!over) eyebrow.classList.add('scrim');
    kit.setProperty('--accent-text', over ?? readableOn(bg, accent, { large: true }));
  },
});

/**
 * The pixels behind the eyebrow's text, at about one per 4 px: the photo under the text's box,
 * wherever the push-in moves it during the spot, under the shade as it is at the box's top and at
 * its bottom (a text over a gradient is measured at both ends). One small canvas read.
 */
async function backdrop(ctx: TemplateContext, eyebrow: HTMLElement, bg: string): Promise<Uint8ClampedArray> {
  // The rise-in moves the eyebrow only up and down, so the text's left and width are where it
  // rests; its top and height come from the layout, which no animation moves.
  const text = document.createRange();
  text.selectNodeContents(eyebrow);
  const { left, width } = text.getBoundingClientRect();
  const top = document.querySelector('.copy')!.getBoundingClientRect().top + eyebrow.offsetTop;
  const height = eyebrow.offsetHeight;
  const w = Math.max(1, Math.ceil(width / 4));
  const h = Math.max(1, Math.ceil(height / 4));
  const g = new OffscreenCanvas(w, 2 * h).getContext('2d')!;
  g.fillStyle = bg;
  g.fillRect(0, 0, w, 2 * h);

  const img = document.querySelector<HTMLImageElement>('.photo img')!;
  // A photo that does not decode is not shown, and the copy then sits on the background.
  if (img.src) await img.decode().catch(() => undefined);
  if (img.naturalWidth && width) {
    const { width: vw, height: vh } = ctx.viewport;
    const push = Number(getComputedStyle(img.parentElement!).getPropertyValue('--push'));
    // object-fit: cover, then scaled about the centre from 1 to `push`: the photo's pixel under a
    // point on screen, along one axis, at scale `s`.
    const k = Math.max(vw / img.naturalWidth, vh / img.naturalHeight);
    const at = (p: number, size: number, natural: number, s: number) => (size / 2 + (p - size / 2) / s - (size - natural * k) / 2) / k;
    const x0 = Math.min(at(left, vw, img.naturalWidth, 1), at(left, vw, img.naturalWidth, push));
    const x1 = Math.max(at(left + width, vw, img.naturalWidth, 1), at(left + width, vw, img.naturalWidth, push));
    const y0 = Math.min(at(top, vh, img.naturalHeight, 1), at(top, vh, img.naturalHeight, push));
    const y1 = Math.max(at(top + height, vh, img.naturalHeight, 1), at(top + height, vh, img.naturalHeight, push));
    g.drawImage(img, x0, y0, x1 - x0, y1 - y0, 0, 0, w, h);
    g.drawImage(img, x0, y0, x1 - x0, y1 - y0, 0, h, w, h);
  }

  const shade = getComputedStyle(document.querySelector('.shade')!);
  const stop = (name: string) => Number.parseFloat(shade.getPropertyValue(name)) / 100;
  const [a0, a1, at1, at2] = [stop('--shade-0'), stop('--shade-1'), stop('--shade-1-at'), stop('--shade-2-at')];
  /** The shade's opacity at `y` on screen; its gradient runs from the bottom. */
  const opacity = (y: number) => {
    const d = 1 - y / ctx.viewport.height;
    return d <= at1 ? a0 + ((a1 - a0) * d) / at1 : d < at2 ? (a1 * (at2 - d)) / (at2 - at1) : 0;
  };
  g.globalAlpha = opacity(top);
  g.fillRect(0, 0, w, h);
  g.globalAlpha = opacity(top + height);
  g.fillRect(0, h, w, h);
  return g.getImageData(0, 0, w, 2 * h).data;
}
