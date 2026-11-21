/**
 * Screens in order (#180): by name as people read them, and the Screens page's sorts. The tools
 * list screens by id, which the Screens page's poll relies on, so they are sorted where they are shown.
 */
import { URGENCY } from './screen-status';
import type { StateKind } from './screen-types';

interface Named {
  id: string;
  name: string;
}
interface ScreenLike extends Named {
  lastSeenAt: number | null;
  state: { kind: StateKind };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** By name as people read it ("Screen 2" before "Screen 10"), then by id, so a tie reads the same every time. */
export const byName = (a: Named, b: Named) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

type Compare = (a: ScreenLike, b: ScreenLike) => number;
const NAME: Compare = () => 0;
// Most urgent first, as the rollup ranks them; asleep is on purpose, so it is last.
const STATUS: Compare = (a, b) => URGENCY.indexOf(a.state.kind) - URGENCY.indexOf(b.state.kind);
// Most recently heard first, as the column's "ago" reads up; never heard from last. Two never heard from tie (NaN).
const HEARD: Compare = (a, b) => (b.lastSeenAt ?? Number.NEGATIVE_INFINITY) - (a.lastSeenAt ?? Number.NEGATIVE_INFINITY) || 0;

/** The Screens page's sorts: a column, and `-` before it for the other way. */
const SORTS = {
  name: { order: NAME, desc: false },
  '-name': { order: NAME, desc: true },
  status: { order: STATUS, desc: false },
  '-status': { order: STATUS, desc: true },
  heard: { order: HEARD, desc: false },
  '-heard': { order: HEARD, desc: true },
} satisfies Record<string, { order: Compare; desc: boolean }>;
export type ScreenSort = keyof typeof SORTS;

/** Whether a value read from the URL is a sort. */
export const isScreenSort = (v: unknown): v is ScreenSort => typeof v === 'string' && Object.hasOwn(SORTS, v);

/** The screens in a sort's order, by name within it; the other way reverses the whole order. */
export function sortScreens<S extends ScreenLike>(screens: readonly S[], sort: ScreenSort): S[] {
  const { order, desc } = SORTS[sort];
  const sorted = [...screens].sort((a, b) => order(a, b) || byName(a, b));
  return desc ? sorted.reverse() : sorted;
}
