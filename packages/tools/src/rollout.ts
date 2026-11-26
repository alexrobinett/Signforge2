/**
 * The rollout outcome: where each screen a publish switched stands on the manifest it gave it,
 * and whether the rollout is over. The one rule for `get_publish`, `list_publishes` (the CMS's
 * publish page) and the API's five-minute check that marks a rollout finished and sends its
 * alert; packages/db only reads the facts it is decided from (`rolloutFacts`).
 *
 * A screen is settled once it reports the manifest (playing: never also replaced, so a screen a
 * later publish switched while it still reports this one counts as playing it), once a later
 * publish moved it on without it reporting this one (replaced), or once it is revoked, which
 * never reports again (revoked). A rollout is over when no screen is open, that is unsettled;
 * an open screen's outcome is its state's (`screenState`).
 */
import type { RolloutCount } from '@signforge/db';
import type { OUTCOMES } from './outputs';
import type { ScreenState } from './screen-state';

type Outcome = (typeof OUTCOMES)[number];

type Facts = Omit<RolloutCount, 'screens'>;

const settled = (f: Facts) => (f.reports ? 'playing' : !f.current ? 'replaced' : f.revoked ? 'revoked' : undefined);

/** Where one screen stands on the manifest a publish gave it, from its facts and, while open, its state. */
export function outcomeOf(f: Facts, state: ScreenState): Outcome {
  const done = settled(f);
  if (done) return done;
  if (state.kind === 'asleep') return 'asleep';
  if (state.kind === 'updating') return 'downloading';
  if (state.kind === 'unreachable' || state.reason === 'behind') return 'unreachable';
  if (state.reason === 'fallback') return 'fell_back';
  return 'waiting';
}

/** A rollout in counts: of `screens` switched, how many are playing, replaced, revoked, and open. Over at `open: 0`. */
interface RolloutTally {
  screens: number;
  playing: number;
  replaced: number;
  revoked: number;
  open: number;
}

/** A rollout's counts, from how many of its screens have each combination of facts. */
export function tally(counts: readonly RolloutCount[]): RolloutTally {
  const t: RolloutTally = { screens: 0, playing: 0, replaced: 0, revoked: 0, open: 0 };
  for (const c of counts) {
    t.screens += c.screens;
    t[settled(c) ?? 'open'] += c.screens;
  }
  return t;
}
