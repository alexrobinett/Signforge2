import { describe, expect, it } from 'vitest';
import { fitWords } from './index';

/** A box that holds `n` characters. */
const holds = (n: number) => (s: string) => s.length <= n;

describe('fitWords', () => {
  it('leaves text that fits alone', () => {
    expect(fitWords('Rain later today', holds(40))).toBe('Rain later today');
  });

  it('ends on a whole word, with the ellipsis against it', () => {
    expect(fitWords('Storm brings heavy rain to the coast', holds(20))).toBe('Storm brings heavy…');
  });

  it('drops punctuation left at the cut', () => {
    expect(fitWords('Markets fall, then recover by noon', holds(14))).toBe('Markets fall…');
  });

  it('does not end on an opening quote or bracket', () => {
    expect(fitWords('Talks resume (closes Friday) after the vote', holds(21))).toBe('Talks resume…');
    expect(fitWords('Un appel pour « la paix » en Europe', holds(18))).toBe('Un appel pour…');
  });

  it('keeps the first word when even that does not fit, for the box to clip', () => {
    expect(fitWords('Extraordinarily long headline', holds(5))).toBe('Extraordinarily…');
  });
});
