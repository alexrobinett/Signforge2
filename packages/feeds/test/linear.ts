import { FeedError } from '../src/index';

export const code = (run: () => unknown) => {
  try {
    run();
  } catch (e) {
    return e instanceof FeedError ? e.code : e;
  }
  return 'no error';
};

/**
 * How fast this machine does a linear pass over 1 MB: every character looked at, every cell made a
 * string and put in a Set, as a parser does. CI's runners are many times slower than a laptop, and
 * busier, so the timing tests bound a parse by this, measured in the same run, rather than by a
 * fixed time. The fastest of three: a pause in one run is not this machine's speed.
 */
export function linearMs(): number {
  const body = Array.from({ length: 135_000 }, (_, i) => `c${i}`).join(',');
  const pass = () => {
    const seen = new Set<string>();
    let cell = '';
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c === ',') {
        seen.add(cell);
        cell = '';
      } else cell += c;
    }
    return seen.add(cell).size;
  };
  return Math.min(
    ...[0, 1, 2].map(() => {
      const t0 = performance.now();
      pass();
      return performance.now() - t0;
    }),
  );
}

/**
 * Whether `parse` finishes within 15 linear passes over 1 MB (`linearMs`): at most the 1 MB fetch
 * limit, a linear parser takes about 1.5 of them. The quadratic checks this guards against took
 * 1,000 to 2,000 (12 to 23 s against 11 ms). Up to three tries, for a runner's pauses; a try past 20
 * times the bound is no pause, and ends it. A `parse` that throws fails the test: one that is meant
 * to refuse its input passes through `code`.
 */
export function inLinearTime(parse: () => unknown, base: number): boolean {
  const bound = 15 * Math.max(base, 1);
  for (let attempt = 0; attempt < 3; attempt++) {
    const t0 = performance.now();
    parse();
    const ms = performance.now() - t0;
    if (ms < bound) return true;
    if (ms > 20 * bound) return false;
  }
  return false;
}
