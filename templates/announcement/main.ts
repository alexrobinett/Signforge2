import { applyLook } from '@signforge/template-looks';
import { BRAND_LOGO, defineTemplate } from '@signforge/template-sdk';
import { qrSvg } from '@signforge/template-sdk/qr';

interface Fact {
  label: string;
  value: string;
}

/** The headline's size at each step, from the look's own down to where 80 characters fit its lines. */
const HEADLINE_STEPS = [1, 0.86, 0.74, 0.64, 0.56, 0.49, 0.43];
/** The body's and the facts' (and Poster's signature's), alongside: they have less room to give. */
const BODY_STEPS = [1, 0.9, 0.8, 0.72, 0.64];

defineTemplate({
  async prepare(ctx) {
    const { data, assets } = ctx;
    const facts: Fact[] = Array.isArray(data.facts) ? data.facts : [];
    const url = String(data.qrUrl);
    // Unpainted until prepare returns: a frame that paints the photo has it decoded for the screen
    // first, and the SDK's decode before ready then waits behind that one (photo-promo, #168).
    const img = document.querySelector<HTMLImageElement>('.photo img');
    if (img) img.style.visibility = 'hidden';
    // An element with nothing to show is off, as if switched off, so the layout closes up around it:
    // no QR address, no logo in the kit, no facts, an empty line. (A photo is always chosen: the
    // contract asks every image field for one.)
    const on = (show: string, has: unknown) => data[show] === true && Boolean(has);
    await applyLook({
      ...ctx,
      data: {
        ...data,
        showQr: on('showQr', url),
        showLogo: on('showLogo', assets[BRAND_LOGO]),
        showFacts: on('showFacts', facts.length),
        showEyebrow: on('showEyebrow', data.eyebrow),
        showBody: on('showBody', data.body),
        showMeta: on('showMeta', data.meta),
      },
    });

    const list = document.getElementById('facts');
    const row = document.querySelector<HTMLTemplateElement>('#fact')?.content.firstElementChild;
    if (list && row)
      facts.forEach((f, i) => {
        const el = row.cloneNode(true);
        if (!(el instanceof HTMLElement)) return;
        el.classList.add(`lk-d${4 + i}`);
        el.querySelector('dt')!.textContent = f.label;
        el.querySelector('dd')!.textContent = f.value;
        list.append(el);
      });
    document.getElementById('qr')?.replaceChildren(qrSvg(url, String(data.qrLabel) || url));

    fit();
    if (img) img.style.visibility = '';
  },
});

/**
 * The largest step at which the headline fits its lines and nothing falls below the copy: the
 * headline's size and the body's and facts' step down together, so long copy at a field's
 * `maxLength` ends in its clamp's ellipsis at the smallest step, never past its box. Each step
 * tried is a style and layout pass, which on a Pi costs tens of milliseconds: short copy takes one,
 * anything else a binary search of the rest.
 */
function fit(): void {
  const copy = document.querySelector<HTMLElement>('.copy')!;
  const headline = document.querySelector<HTMLElement>('.headline')!;
  // Glyphs overhang a tight leading by a few pixels; clamped text hides at least a line.
  const clamped = (el: HTMLElement) => el.scrollHeight - el.clientHeight > Number.parseFloat(getComputedStyle(el).fontSize) / 2;
  // By layout, not by painted boxes: the intros' transforms are not where the copy rests.
  const overflows = () =>
    [...copy.children].some((el) => {
      if (!(el instanceof HTMLElement) || !(el.offsetParent instanceof HTMLElement)) return false;
      const box = el.offsetParent;
      // The margin box: a mask's padding for descenders is taken back by its negative margin.
      const bottom = el.offsetTop + el.offsetHeight + Number.parseFloat(getComputedStyle(el).marginBottom);
      return bottom > box.clientHeight - Number.parseFloat(getComputedStyle(box).paddingBottom) + 1;
    });
  // On the copy, not the root: a custom property set on the root restyles the whole document.
  const set = (k: number) => {
    copy.style.setProperty('--fit-headline', String(HEADLINE_STEPS[k]));
    copy.style.setProperty('--fit-body', String(BODY_STEPS[Math.min(k, BODY_STEPS.length - 1)]));
  };
  const fits = (k: number) => (set(k), !clamped(headline) && !overflows());
  if (fits(0)) return;
  let [lo, hi] = [1, HEADLINE_STEPS.length - 1];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (fits(mid)) hi = mid;
    else lo = mid + 1;
  }
  set(lo);
}
