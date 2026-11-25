import { defineTemplate } from '@signforge/template-sdk';
import { qrSvg } from '@signforge/template-sdk/qr';

/**
 * Each severity's word and colours: ink on its ground, and the band the other way round. Fixed on
 * purpose, whatever the screen's brand kit: a kit's colours must not decide whether an evacuation
 * notice reads. Every pair is 7:1 or better.
 */
const SEVERITIES: Record<string, { label: string; ground: string; ink: string }> = {
  emergency: { label: 'Emergency', ground: '#991b1b', ink: '#ffffff' },
  warning: { label: 'Warning', ground: '#f59e0b', ink: '#111827' },
  advisory: { label: 'Advisory', ground: '#fde047', ink: '#111827' },
  notice: { label: 'Notice', ground: '#1e3a8a', ink: '#ffffff' },
};

/**
 * Halvings of the search for the largest scale at which text fits its region: within 1/64 of it, seven layouts at most.
 * Eight took a cold prepare of the widest copy to 590 ms on the Pi, over the 500 ms budget (review of #448).
 */
const STEPS = 6;
/** A line may stand this far past its region's edge, for sub-pixel layout: never a whole pixel. */
const SLACK = 0.5;

type Side = 'top' | 'bottom';
/**
 * Whether every line of text in `region` lies inside its box on the sides text can run out of: left, right and `side`,
 * the end it grows towards. Measured line by line (`Range.getClientRects`), as laid out: a line's box is its font's
 * whole height, which stands out past a tight line on the side the text starts from, so that side is not measured.
 */
function linesFit(region: Element, side: Side): boolean {
  const box = region.getBoundingClientRect();
  const range = document.createRange();
  const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    range.selectNodeContents(node);
    for (const line of range.getClientRects()) {
      if (line.left < box.left - SLACK || line.right > box.right + SLACK) return false;
      if (side === 'bottom' ? line.bottom > box.bottom + SLACK : line.top < box.top - SLACK) return false;
    }
  }
  return true;
}

/**
 * Sets `name` on the root to the largest scale, from 1 down with no floor, at which `fits` holds: 1 when the text fits as
 * it is (one layout, as realistic copy does), else a binary search. Small text beats hidden or covered text in an
 * emergency (review of #448, round 3).
 */
function fitScale(root: HTMLElement, name: string, fits: () => boolean): void {
  root.style.setProperty(name, '1');
  if (fits()) return;
  let [low, high] = [0, 1];
  for (let i = 0; i < STEPS; i++) {
    const mid = (low + high) / 2;
    root.style.setProperty(name, String(mid));
    if (fits()) low = mid;
    else high = mid;
  }
  root.style.setProperty(name, String(low));
}

defineTemplate({
  async prepare(ctx) {
    const { root, data } = ctx;
    const severity = SEVERITIES[String(data.severity)]!;
    root.dataset.severity = String(data.severity);
    root.style.setProperty('--ground', severity.ground);
    root.style.setProperty('--ink', severity.ink);
    document.getElementById('label')!.textContent = severity.label;
    document.getElementById('ends')!.textContent = `Ends at ${String(data.endsAt)}`;

    // The look kit's toggle convention (docs/template-spec.md, Looks): a mark on the root, and what
    // is off removed, so the grid closes up. A QR code with no address is off, and so is an empty end.
    const url = String(data.qrUrl);
    const shown = {
      qr: data.showQr === true && url !== '',
      'issued-by': data.showIssuedBy === true,
      'ends-at': data.showEndsAt === true && String(data.endsAt) !== '',
    };
    for (const [mark, on] of Object.entries(shown)) {
      root.setAttribute(`data-${mark}`, on ? 'on' : 'off');
      if (!on) for (const el of document.querySelectorAll(`[data-show="${mark}"]`)) el.remove();
    }
    if (shown.qr) document.getElementById('qr')!.replaceChildren(qrSvg(url, String(data.qrLabel)));

    // Measured in the template's own faces: lay out, so they load, then wait for them.
    const body = document.querySelector<HTMLElement>('.body')!;
    body.getBoundingClientRect();
    const page = document.body;
    await document.fonts.ready;
    // New data while the faces loaded: the SDK put a fresh copy of the loaded body in place and
    // inits again. Rejecting stops this prepare there, and the SDK drops a superseded prepare's error.
    if (document.body !== page) throw new Error('new data replaced this prepare');
    // Each region's text scales until it fits there: the caption under the code on its own, the copy and the meta line
    // together. Measured with the intros off, as the text lies when it plays.
    root.dataset.measuring = '';
    const caption = document.querySelector('.qr figcaption');
    if (caption) fitScale(root, '--cap-fit', () => linesFit(caption, 'bottom'));
    const copy = document.querySelector('.copy')!;
    const meta = document.querySelector('.meta')!;
    fitScale(root, '--fit', () => linesFit(copy, 'bottom') && linesFit(meta, 'top'));
    delete root.dataset.measuring;
  },
});
