import { describe, expect, it } from 'vitest';
import { readableOn } from './contrast';

describe('readableOn', () => {
  it('keeps text that reads on its fill', () => {
    // White on the demo kit's blue is 6.70:1.
    expect(readableOn('#1d4ed8', '#ffffff')).toBe('#ffffff');
    expect(readableOn('#fff', '#c8102e')).toBe('#c8102e');
  });

  it('swaps text that does not for black or white, whichever reads better', () => {
    // White on the default palette's amber is 2.14:1; black is 9.79:1.
    expect(readableOn('#f59e0b', '#fff')).toBe('#000000');
    // A blue on a blue: white (6.70:1) beats black (3.13:1).
    expect(readableOn('#1d4ed8', '#2563eb')).toBe('#ffffff');
  });

  it('chooses black or white when there is no text colour to keep', () => {
    expect(readableOn('#f59e0b', '')).toBe('#000000');
  });

  it('keeps the text on a fill it cannot measure', () => {
    expect(readableOn('rebeccapurple', '#fff')).toBe('#fff');
  });
});
