import { describe, expect, it } from 'vitest';
import { parseTransitionOverride } from './transition-override';

describe('the ?transition= testing override', () => {
  it('is absent when not given', () => {
    expect(parseTransitionOverride(null)).toBeUndefined();
  });

  it('takes the named transitions, at 500 ms when no length is given', () => {
    expect(parseTransitionOverride('cut')).toEqual({ type: 'cut' });
    expect(parseTransitionOverride('crossfade')).toEqual({ type: 'crossfade', ms: 500 });
    expect(parseTransitionOverride('fade')).toEqual({ type: 'fade', ms: 500 });
  });

  it('takes a length in milliseconds: alone for a crossfade, after "fade" for a fade', () => {
    expect(parseTransitionOverride('800')).toEqual({ type: 'crossfade', ms: 800 });
    expect(parseTransitionOverride('fade600')).toEqual({ type: 'fade', ms: 600 });
  });

  it('refuses anything else, naming what it takes', () => {
    for (const bad of ['', 'dissolve', 'crossfade500', 'fadex', 'fade0', '0', '10001', '1.5', '-5', ' 500']) {
      expect(() => parseTransitionOverride(bad), bad).toThrow(
        `?transition=${bad}: expected cut, crossfade, fade, fade<ms> or <ms> (a crossfade), with ms a whole number from 1 to 10000`,
      );
    }
  });
});
