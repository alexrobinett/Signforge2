import { describe, expect, it } from 'vitest';
import { readableOver } from './backdrop';

/** RGBA pixels of `#rrggbb` colours. */
const pixels = (...colors: string[]) =>
  new Uint8ClampedArray(colors.flatMap((c) => [...(c.slice(1).match(/../g) ?? []).map((v) => Number.parseInt(v, 16)), 255]));

describe('readableOver', () => {
  it('keeps text that reads on every pixel', () => {
    // Green on white is 3.30:1: enough for large text only.
    expect(readableOver(pixels('#ffffff', '#ffffff'), '#16a34a', { large: true })).toBe('#16a34a');
    expect(readableOver(pixels('#000000', '#1d4ed8'), '#fff')).toBe('#fff');
  });

  it('gives way to black or white, whichever reads better on its worst pixel, when one pixel fails', () => {
    expect(readableOver(pixels('#ffffff'), '#16a34a')).toBe('#000000');
    // Green on the default palette's amber is 1.52:1; black reads on amber at 9.79:1, white on white not at all.
    expect(readableOver(pixels('#ffffff', '#f59e0b'), '#16a34a', { large: true })).toBe('#000000');
    expect(readableOver(pixels('#000000', '#1d4ed8'), '#f59e0b')).toBe('#ffffff');
  });

  it('is undefined where neither black nor white reads on every pixel', () => {
    // Mid grey is 3.95:1 to white and 5.32:1 to black: each reads on large text alone, neither on both.
    expect(readableOver(pixels('#ffffff', '#808080', '#000000'), '#ffffff', { large: true })).toBeUndefined();
  });

  it('does not keep text it cannot measure', () => {
    expect(readableOver(pixels('#ffffff'), 'rebeccapurple')).toBe('#000000');
  });
});
