/**
 * How the Screens page joins its poll to the list it loaded (src/queries/screens.ts): the poll
 * says what each screen is doing; the list, read again when it is out of date, says the rest.
 */
import type { ScreenStatus, ScreenView } from './screen-types';

/**
 * Which screens there are, what each should play and the kind of its state. The list's `showing`
 * (asleep, or the spot) follows from all three, so a change to any makes the list out of date: a
 * screen that wakes is read again once, and its tile never says Online over an Asleep thumbnail.
 */
const fleetOf = (screens: readonly Pick<ScreenView, 'id' | 'desiredManifestId' | 'state'>[]) =>
  screens.map((s) => `${s.id}:${s.desiredManifestId}:${s.state.kind}`).join();

/** Whether the poll has seen what the list does not have, so the list must be read again. Both are ordered by id. */
export const listOutOfDate = (list: readonly ScreenView[], status: readonly ScreenStatus[]) => fleetOf(list) !== fleetOf(status);

/** Whether a screen came or went since the list was read: all a page that shows only the roster needs read again. */
export const rosterOutOfDate = (list: readonly ScreenView[], status: readonly ScreenStatus[]) =>
  list.map((s) => s.id).join() !== status.map((s) => s.id).join();

/** The screens as last read, with what the poll says each is doing, when the poll is the newer. */
export function withStatus(screens: ScreenView[], at: number, live: { screens: ScreenStatus[]; at: number } | undefined): ScreenView[] {
  if (!live || live.at < at) return screens;
  const byId = new Map(live.screens.map((s) => [s.id, s]));
  return screens.map((s) => ({ ...s, ...byId.get(s.id) }));
}
