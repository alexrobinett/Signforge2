/**
 * List-row images and `data-sf-src` on rows (#196): fill a row's `[data-sf]` text and
 * `[data-sf-src]` images from `ctx`, the way `defineTemplate` fills top-level fields.
 *
 * Its own entry point (`@signforge/template-sdk/rows`), apart from the index, so templates that
 * do not use list-row images keep their built bundles byte for byte.
 */
import { rowAsset } from '@signforge/contract/row-asset';
import type { TemplateContext } from './index';

export { rowAsset };

type RowContext = Pick<TemplateContext, 'data' | 'assets'>;

/** Object URL for a list row's image (`file` for lead, `thumb` for row thumbnail), or undefined when absent or missing. */
export function rowImage(
  ctx: Pick<TemplateContext, 'assets'>,
  field: string,
  index: number,
  prop: string,
  variant: 'file' | 'thumb' = 'file',
): string | undefined {
  return ctx.assets[rowAsset(field, index, prop, variant)];
}

/**
 * Resolve a `data-sf-src` value on a row: `prop` or `prop:thumb`. Only the row's own image: a row
 * whose image did not arrive has none, never a top-level asset of the same name.
 */
function resolveRowSrc(ctx: Pick<TemplateContext, 'assets'>, field: string, index: number, attr: string): string | undefined {
  return attr.endsWith(':thumb') ? rowImage(ctx, field, index, attr.slice(0, -':thumb'.length), 'thumb') : rowImage(ctx, field, index, attr);
}

/**
 * Fill `[data-sf]` text and `[data-sf-src]` image elements inside `el` (and `el` itself) for row
 * `index` of list `field`. An image whose blob did not arrive (or a row with no image) has its
 * `src` removed and is hidden, so a missing image never leaves an empty frame; so has one the
 * browser cannot draw, such as a pass-through photo cut short before its image data (review of
 * #240): the SDK waits for every image's decode and then two frames before `ready`, so the row is
 * text only by then.
 */
export function bindRow(el: Element, ctx: RowContext, field: string, index: number): void {
  const list = ctx.data[field];
  const raw: unknown = Array.isArray(list) ? list[index] : undefined;
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const textNodes = [...el.querySelectorAll<HTMLElement>('[data-sf]')];
    if (el instanceof HTMLElement && el.matches('[data-sf]')) textNodes.unshift(el);
    for (const node of textNodes) {
      const key = node.dataset.sf;
      if (!key || !Object.hasOwn(raw, key)) continue;
      const v: unknown = Reflect.get(raw, key);
      if (v !== undefined) node.textContent = String(v);
    }
  }
  const images = [...el.querySelectorAll<HTMLImageElement>('[data-sf-src]')];
  if (el instanceof HTMLImageElement && el.matches('[data-sf-src]')) images.unshift(el);
  for (const img of images) {
    const attr = img.dataset.sfSrc;
    const url = attr ? resolveRowSrc(ctx, field, index, attr) : undefined;
    if (url) {
      img.src = url;
      img.hidden = false;
      // Only while it still shows this photo: a later bind's `src` aborts this decode, and must not be cleared.
      const drop = () => {
        if (img.src !== url) return;
        img.removeAttribute('src');
        img.hidden = true;
      };
      img.addEventListener('error', drop, { once: true });
      img.decode().catch(drop);
    } else {
      img.removeAttribute('src');
      img.hidden = true;
    }
  }
}
