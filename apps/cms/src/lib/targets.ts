/**
 * Finding screens and groups (#180): the order people read them in, a search over their names, and
 * how many screens a group reaches. The target picker, ⌘K and the Screens page share it. The tools
 * list both by id, which the Screens page's poll relies on, so they are sorted where they are shown.
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
interface GroupLike extends Named {
  screenIds: string[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** By name as people read it ("Screen 2" before "Screen 10"), then by id, so a tie reads the same every time. */
export const byName = (a: Named, b: Named) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Whether every word of the query is in one of the texts, in any case. An empty query matches. */
const matchesQuery = (query: string, texts: string[]) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = texts.map((t) => t.toLowerCase());
  return words.every((w) => hay.some((t) => t.includes(w)));
};

/** What a screen is found by: its name and its groups' names. */
const screenKeywords = (screen: Named, groups: readonly GroupLike[]) => [
  screen.name,
  ...groups.filter((g) => g.screenIds.includes(screen.id)).map((g) => g.name),
];

/** What a query finds, by name: every screen (as "every" or "all"), the groups by name, the screens by name or group. */
export function findTargets<S extends ScreenLike, G extends GroupLike>(query: string, screens: readonly S[], groups: readonly G[]) {
  return {
    org: matchesQuery(query, ['Every screen', 'all']),
    groups: groups.filter((g) => matchesQuery(query, [g.name])).sort(byName),
    screens: screens.filter((s) => matchesQuery(query, screenKeywords(s, groups))).sort(byName),
  };
}

const NAMED = 3;

/** "3 screens: 0142 Drive-thru L, 0157 Drive-thru R, 0157 Lobby promo": whom picking a group reaches. */
export function groupReach(group: GroupLike, screens: readonly Named[]): string {
  const members = screens.filter((s) => group.screenIds.includes(s.id)).sort(byName);
  if (!members.length) return 'No screens in it yet';
  const named = members
    .slice(0, NAMED)
    .map((s) => s.name)
    .join(', ');
  const more = members.length > NAMED ? ` and ${members.length - NAMED} more` : '';
  return `${members.length} ${members.length === 1 ? 'screen' : 'screens'}: ${named}${more}`;
}

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
