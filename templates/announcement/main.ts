import { applyLook } from '@signforge/template-looks';
import { BRAND_LOGO, defineTemplate } from '@signforge/template-sdk';
import { qrSvg } from '@signforge/template-sdk/qr';

interface Fact {
  label: string;
  value: string;
}

/** The headline's size at each step, from the look's own down to where 80 characters fit its lines. */
const HEADLINE_STEPS = [1, 0.86, 0.74, 0.64, 0.56, 0.49, 0.43];
/** The body's and the facts' (and Poster's signature's), which have less room to give. */
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
    // no photo uploaded, no QR address, no logo in the kit, no facts, an empty line.
    const on = (show: string, has: unknown) => data[show] === true && Boolean(has);
    await applyLook({
      ...ctx,
      data: {
        ...data,
        showPhoto: on('showPhoto', assets.photo),
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

    fit(ctx.root);
    if (img) img.style.visibility = '';
  },
});

/**
 * Step the headline, then the body, down from the look's sizes until each fits its lines and the
 * copy fits the screen. Long copy at a field's `maxLength` then ends in its clamp's ellipsis at the
 * smallest step, never past its box. A layout per step tried; short copy takes one.
 */
function fit(root: HTMLElement): void {
  const headline = document.querySelector<HTMLElement>('.headline')!;
  const body = document.querySelector<HTMLElement>('.body');
  // Glyphs overhang a tight leading by a few pixels; clamped text hides at least a line.
  const clamped = (el: HTMLElement | null) => !!el && el.scrollHeight - el.clientHeight > Number.parseFloat(getComputedStyle(el).fontSize) / 2;
  // By layout, not by painted boxes: the intros' transforms are not where the copy rests.
  const overflows = () =>
    [...document.querySelectorAll<HTMLElement>('.copy > *')].some((el) => {
      const box = el.offsetParent;
      if (!(box instanceof HTMLElement)) return false;
      // The margin box: a mask's padding for descenders is taken back by its negative margin.
      const bottom = el.offsetTop + el.offsetHeight + Number.parseFloat(getComputedStyle(el).marginBottom);
      return bottom > box.clientHeight - Number.parseFloat(getComputedStyle(box).paddingBottom) + 1;
    });
  const set = (name: string, steps: number[], i: number) => root.style.setProperty(name, String(steps[i]));
  let h = 0;
  let b = 0;
  while (h < HEADLINE_STEPS.length - 1 && clamped(headline)) set('--fit-headline', HEADLINE_STEPS, ++h);
  while (b < BODY_STEPS.length - 1 && clamped(body)) set('--fit-body', BODY_STEPS, ++b);
  while (overflows() && (h < HEADLINE_STEPS.length - 1 || b < BODY_STEPS.length - 1)) {
    if (h < HEADLINE_STEPS.length - 1) set('--fit-headline', HEADLINE_STEPS, ++h);
    if (b < BODY_STEPS.length - 1) set('--fit-body', BODY_STEPS, ++b);
  }
}
