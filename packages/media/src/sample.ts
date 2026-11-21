/**
 * An image's sample (`ManifestFile.sample` in the contract), from the pixels a screen decodes it
 * to: each cell's darkest and lightest pixel, as RGBA pixels of `imageSampleSize`. Pure, so the CMS
 * (in the browser, before upload) and `sf build` (with sharp) make the same one; each encodes it as
 * a PNG.
 */
import { IMAGE_SAMPLE_CELL, imageSampleSize } from '@signforge/contract';

/** The sample of a `width`x`height` image given as RGBA pixels; undefined when any pixel is not opaque. */
export function imageSample(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number } | undefined {
  const size = imageSampleSize(width, height);
  const half = size.height / 2;
  const data = new Uint8ClampedArray(size.width * size.height * 4);
  const darkest = new Float64Array(size.width * half).fill(Number.POSITIVE_INFINITY);
  const lightest = new Float64Array(size.width * half).fill(Number.NEGATIVE_INFINITY);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (rgba[i + 3] !== 255) return undefined;
      const l = 0.2126 * LINEAR[rgba[i]!]! + 0.7152 * LINEAR[rgba[i + 1]!]! + 0.0722 * LINEAR[rgba[i + 2]!]!;
      const cell = Math.floor(y / IMAGE_SAMPLE_CELL) * size.width + Math.floor(x / IMAGE_SAMPLE_CELL);
      if (l < darkest[cell]!) {
        darkest[cell] = l;
        data.set(rgba.subarray(i, i + 4), cell * 4);
      }
      if (l > lightest[cell]!) {
        lightest[cell] = l;
        data.set(rgba.subarray(i, i + 4), (half * size.width + cell) * 4);
      }
    }
  }
  return { data, ...size };
}

/** WCAG's linear value of each 8-bit sRGB channel value, as the template SDK's `readableOver` reads it. */
const LINEAR = Float64Array.from({ length: 256 }, (_, v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
