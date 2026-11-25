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
 * The most probes of the search for the largest scale at which text fits its region, after the one at full size. Eight
 * always find it within PRECISION: the estimate and the stride leave a bracket narrower than 1, and six halvings take
 * any such to 1/64 (six probes could stop short, review of #448, round 5). The search stops as soon as every bracket is
 * that narrow, five layouts as a rule. A search of eight halvings for each region in turn took a cold prepare of the
 * widest copy to 590 ms on the Pi, over the 500 ms budget.
 */
const PROBES = 8;
/** How close the scale is found, and the first step from the estimate. */
const PRECISION = 1 / 64;
const STRIDE = 1 / 16;
/** A line may stand this far past its region's edge, for sub-pixel layout: never a whole pixel. */
const SLACK = 0.5;

type Side = 'top' | 'bottom';
/**
 * Whether the text of `region` lies inside its box on the sides text can run out of: left and right, line by line
 * (`Range.getClientRects`), and `side`, the end it grows towards, by the boxes of the blocks it is in, which are its line
 * boxes. A line's own rect is its font's whole height, which a tall fallback font stands past its line box by a pixel
 * at some sizes, so the height is measured by the blocks: what fits is then the same at every smaller scale, and ink
 * past a box is clipped (style.css). With it, what the text needs: the height it takes against the region's, and the
 * width it would at most fit in, as a share of what it takes.
 */
function measure(region: Element, side: Side): { fits: boolean; height: number; room: number; across: number } {
  const box = region.getBoundingClientRect();
  const range = document.createRange();
  const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
  let [left, right, top, bottom] = [box.left, box.left, box.bottom, box.top];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    range.selectNodeContents(node);
    for (const line of range.getClientRects()) [left, right] = [Math.min(left, line.left), Math.max(right, line.right)];
  }
  for (const block of region.children) {
    const r = block.getBoundingClientRect();
    [top, bottom] = [Math.min(top, r.top), Math.max(bottom, r.bottom)];
  }
  const across = left >= box.left - SLACK && right <= box.right + SLACK;
  const fits = across && (side === 'bottom' ? bottom <= box.bottom + SLACK : top >= box.top - SLACK);
  const height = side === 'bottom' ? bottom - box.top : box.bottom - top;
  return { fits, height, room: box.height, across: box.width / (right - left) };
}

/**
 * Sets each scale (`name` on the root) to the largest, from 1 down with no floor, at which its regions' text fits: 1 when
 * it fits as it is (one layout, as realistic copy does). Else it probes the scale estimated from that layout, then one
 * STRIDE from it towards the answer, then halves what is left until it is within PRECISION: five layouts as a rule,
 * never more than PROBES and one, and it keeps the largest scale seen to fit. The regions are independent, so their searches share each layout: every
 * step sets every scale and one layout answers every check. Small text beats hidden or covered text in an emergency
 * (review of #448).
 */
function fitScales(root: HTMLElement, scales: [name: string, groups: [Element, Side][][]][]): void {
  // The scale estimated to fit: wrapped text needs height about as the square of the scale, and a glyph too wide to wrap
  // needs width as the scale. Over each group of regions together, as one may take room from another (the meta line's
  // row grows into the copy's when they share a column), and the smallest of the groups'.
  const check = (groups: [Element, Side][][]) => {
    let [fits, estimate] = [true, 1];
    for (const group of groups) {
      const all = group.map(([el, side]) => measure(el, side));
      const sum = (k: 'height' | 'room') => all.reduce((n, m) => n + m[k], 0);
      fits &&= all.every((m) => m.fits);
      estimate = Math.min(estimate, Math.sqrt(sum('room') / sum('height')), ...all.map((m) => m.across));
    }
    return { fits, estimate };
  };
  for (const [name] of scales) root.style.setProperty(name, '1');
  const open = scales.flatMap(([name, regions]) => {
    const { fits, estimate } = check(regions);
    return fits ? [] : [{ name, regions, low: 0, high: 1, next: estimate, probed: 0 }];
  });
  for (let i = 0; i < PROBES && open.some((s) => s.high - s.low > PRECISION); i++) {
    const live = open.filter((s) => s.high - s.low > PRECISION);
    for (const s of live) root.style.setProperty(s.name, String(s.next));
    for (const s of live) {
      const at = s.next;
      if (check(s.regions).fits) s.low = at;
      else s.high = at;
      s.probed += 1;
      // From the estimate a stride towards the answer, then halves; a step that would leave the bracket halves it.
      const step = s.probed === 1 ? (s.low === at ? at + STRIDE : at - STRIDE) : (s.low + s.high) / 2;
      s.next = step > s.low && step < s.high ? step : (s.low + s.high) / 2;
    }
  }
  for (const s of open) root.style.setProperty(s.name, String(s.low));
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
    const copy = document.querySelector('.copy')!;
    const meta = document.querySelector('.meta')!;
    // The copy and the meta line share a column in landscape, and in portrait without the code; beside the code in
    // portrait the meta line has a region of its own.
    const shared = root.dataset.orientation !== 'portrait' || !caption;
    const text: [Element, Side][] = [
      [copy, 'bottom'],
      [meta, 'top'],
    ];
    const scales: [string, [Element, Side][][]][] = [['--fit', shared ? [text] : text.map((region) => [region])]];
    if (caption) scales.push(['--cap-fit', [[[caption, 'bottom']]]]);
    fitScales(root, scales);
    delete root.dataset.measuring;
  },
});
