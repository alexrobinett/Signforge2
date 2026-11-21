import { describe, expect, it } from 'vitest';
import { imageSample } from '../src/sample';

/** Opaque grey pixels of these levels. */
const greys = (levels: number[]) => new Uint8ClampedArray(levels.flatMap((v) => [v, v, v, 255]));

describe('imageSample', () => {
  it("has each 16 px cell's darkest pixel in its top half and its lightest in its bottom half, cells cut by the edge included", () => {
    // 20x2: the first cell is columns 0-15, the second, cut by the edge, columns 16-19.
    const row = (offset: number) => Array.from({ length: 20 }, (_, x) => 10 * x + offset);
    const s = imageSample(greys([...row(5), ...row(0)]), 20, 2)!;
    expect([s.width, s.height]).toEqual([2, 2]);
    expect([...s.data].filter((_, i) => i % 4 === 0)).toEqual([0, 160, 155, 195]);
  });

  it('keeps the colour of the pixel at each extreme, by WCAG luminance, not by its channels', () => {
    // Pure blue, a channel at 255, is darker than #555555 (0.0722 against 0.0908).
    const s = imageSample(new Uint8ClampedArray([0x55, 0x55, 0x55, 255, 0, 0, 255, 255]), 2, 1)!;
    expect([...s.data]).toEqual([0, 0, 255, 255, 0x55, 0x55, 0x55, 255]);
  });

  it('is undefined for an image with any pixel not opaque', () => {
    const rgba = greys([0, 0]);
    rgba[7] = 254;
    expect(imageSample(rgba, 2, 1)).toBeUndefined();
  });
});
