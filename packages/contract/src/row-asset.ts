/**
 * A list row's image (`NewsImage` in a list item's `image` property), as a template reads it: the
 * values a bundle carries when its template reads list-row images, as `@signforge/contract/row-asset`.
 * Apart from `frame.ts` so that templates which read no list-row images keep their bundles byte for byte.
 */

/** The key under which `init`'s `assets` carries a list row's image (`file` for lead, `thumb` for row thumbnail). */
export const rowAsset = (field: string, index: number, prop: string, variant: 'file' | 'thumb' = 'file') =>
  variant === 'thumb' ? `${field}.${index}.${prop}:thumb` : `${field}.${index}.${prop}`;
