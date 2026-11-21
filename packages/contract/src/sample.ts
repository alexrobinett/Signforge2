/**
 * An image's sample (`ManifestFile.sample`), as a template reads it: the values a bundle carries
 * when its template reads one, as `@signforge/contract/sample`. Apart from `frame.ts` so that
 * templates which read no sample keep their bundles byte for byte.
 */

/** The side in pixels of a cell of an image's sample. */
export const IMAGE_SAMPLE_CELL = 16;

/** The key under which `init`'s `assets` carries the sample of an image field's image. */
export const sampleAsset = (field: string) => `${field}:sample`;
