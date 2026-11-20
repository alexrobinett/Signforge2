import type { Transition } from '@signforge/contract';

/** The CMS's length for a new fade or crossfade. */
const DEFAULT_MS = 500;

/** Whole milliseconds the contract accepts for a fade or crossfade, or undefined. */
function ms(s: string): number | undefined {
  if (!/^\d+$/.test(s)) return undefined;
  const n = Number(s);
  return n >= 1 && n <= 10_000 ? n : undefined;
}

/** `?transition=` (testing): cut, crossfade, fade, fade<ms> or <ms> for a crossfade. Throws on anything else. */
export function parseTransitionOverride(t: string | null): Transition | undefined {
  if (t === null) return undefined;
  if (t === 'cut') return { type: 'cut' };
  if (t === 'crossfade') return { type: 'crossfade', ms: DEFAULT_MS };
  if (t === 'fade') return { type: 'fade', ms: DEFAULT_MS };
  const fadeMs = t.startsWith('fade') ? ms(t.slice(4)) : undefined;
  if (fadeMs) return { type: 'fade', ms: fadeMs };
  const crossfadeMs = ms(t);
  if (crossfadeMs) return { type: 'crossfade', ms: crossfadeMs };
  throw new Error(`?transition=${t}: expected cut, crossfade, fade, fade<ms> or <ms> (a crossfade), with ms a whole number from 1 to 10000`);
}
