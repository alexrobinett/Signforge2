/**
 * The look kit's script side (docs/template-spec.md, Looks). A template that uses the kit imports
 * `looks.css` into its `style.css`, declares a `look` select field with the options in `LOOKS`, and
 * awaits `applyLook(ctx)` first in `prepare`.
 */
import type { TemplateContext } from '@signforge/template-sdk';
import { readableOn } from '@signforge/template-sdk/contrast';

/** The options of a template's `look` field. */
export const LOOKS = ['pop', 'poster', 'night', 'corporate'] as const;

/** Text colours `looks.css` asks for, each with what it is measured on and whether it is large text only. */
const INKS = [
  ['--lk-on-primary', '--lk-primary', false],
  ['--lk-on-accent', '--lk-accent', false],
  ['--lk-primary-ink', '--lk-bg', false],
  ['--lk-primary-ink-large', '--lk-bg', true],
  ['--lk-accent-ink', '--lk-bg', false],
  ['--lk-accent-ink-large', '--lk-bg', true],
] as const;

/**
 * Put the spot's look and toggles on the root and choose the look's text colours:
 * - `data-look` from the `look` field;
 * - each boolean field `show<Name>` as `data-<name>="on|off"` (`showNowLine` is `data-now-line`),
 *   for layout CSS, and each element marked `data-show="<name>"` removed when it is off, so the
 *   layout reflows around what is left and a hidden photo is never decoded;
 * - each ink and on-colour through `readableOn`, on the page or on its fill;
 * - the look's faces loaded, before anything is measured.
 */
export async function applyLook(ctx: TemplateContext): Promise<void> {
  const { root, data } = ctx;
  root.dataset.look = String(data.look);
  for (const [field, on] of Object.entries(data)) {
    const name = /^show([A-Z]\w*)$/.exec(field)?.[1];
    if (!name || typeof on !== 'boolean') continue;
    const mark = name.replace(/[A-Z]/g, (c, i: number) => (i ? '-' : '') + c.toLowerCase());
    root.setAttribute(`data-${mark}`, on ? 'on' : 'off');
    if (!on) for (const el of document.querySelectorAll(`[data-show="${mark}"]`)) el.remove();
  }
  const style = getComputedStyle(root);
  const read = (v: string) => style.getPropertyValue(v).trim();
  const inks = INKS.map(([ink, on, large]) => [ink, readableOn(read(on), read(ink), { large })] as const);
  for (const [ink, colour] of inks) root.style.setProperty(ink, colour);
  // A face loads once laid-out text asks for it, and the look's families are chosen only now: lay
  // out, then wait, so text measured in prepare (a crawl, `fitWords`) is in the look's own type.
  // Only the faces the text uses load (Night's bold mono, say, only where a template uses it).
  root.getBoundingClientRect();
  await document.fonts.ready;
}

/**
 * Fill a `.lk-crawl` strip: its content twice (the second copy hidden from assistive tech, and
 * from the still frame), sliding left by exactly one copy at the look's `--lk-crawl-speed`, so it
 * loops seamlessly at the same speed however long the text is.
 */
export function crawl(strip: HTMLElement, ctx: TemplateContext): void {
  const copy = document.createElement('span');
  copy.append(...strip.childNodes);
  const twin = document.createElement('span');
  twin.append(...[...copy.childNodes].map((n) => n.cloneNode(true)));
  twin.setAttribute('aria-hidden', 'true');
  strip.append(copy, twin);
  const width = strip.scrollWidth / 2;
  const vmin = Math.min(ctx.viewport.width, ctx.viewport.height) / 100;
  const pxPerS = Number.parseFloat(getComputedStyle(strip).getPropertyValue('--lk-crawl-speed')) * vmin;
  strip.style.setProperty('--lk-crawl-shift', `${-width}px`);
  strip.style.setProperty('--lk-crawl-s', `${width / pxPerS}s`);
}
