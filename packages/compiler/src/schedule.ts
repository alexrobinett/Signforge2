/**
 * The Screen schedule (#330): which of an org's schedule entries reach one screen, as the contract's `ScheduleEntry`,
 * in the order the screen must get them. The publish, `sf build` and the CMS's week view all call this, so what a
 * screen is compiled with, what a local build gives it and what the CMS shows for it never disagree. Which entry wins
 * at an instant is the screen's own rule (player-core's `resolvePlaylist`), run on this.
 */
import type { ScheduleEntry } from '@signforge/contract';

/** A schedule entry as an org holds it: the contract's, aimed at a group or screen by id, and where it sorts. */
export type TargetedEntry = ScheduleEntry & {
  /** The group or screen id for `group` and `screen` entries; unused for `org`. */
  targetId?: string;
  /**
   * Where it sorts: when it was published, for the publish; a project's own order, for `sf build`; and after every
   * published one for a draft, in the CMS. Of two otherwise tied entries a screen plays the later (`ScheduleEntry`).
   */
  order: number;
};

/** A screen as its schedule sees it: its id and the groups it is in. */
export interface ScheduleScreen {
  id: string;
  groups: readonly string[];
}

/** The group or screen an entry stored as `groupId` and `screenId` (a row, a tool's output) is aimed at. */
export const targetIdOf = (e: { target: TargetedEntry['target']; groupId?: string | null; screenId?: string | null }): string | undefined =>
  (e.target === 'group' ? e.groupId : e.target === 'screen' ? e.screenId : undefined) ?? undefined;

/** Why an entry cannot be placed on any screen: one the compiler reports rather than leaves out. */
export function entryProblems(e: Pick<TargetedEntry, 'target' | 'targetId'>): string[] {
  if (!['org', 'group', 'screen'].includes(e.target)) return ['target must be org, group or screen'];
  if (e.target !== 'org' && !e.targetId) return [`a ${e.target} entry needs a targetId`];
  return [];
}

/** Whether `e` reaches `screen`: aimed at every screen, one of its groups, or it. */
export const reaches = (e: Pick<TargetedEntry, 'target' | 'targetId'>, screen: ScheduleScreen): boolean =>
  e.target === 'org' || (e.target === 'group' && screen.groups.includes(e.targetId ?? '')) || (e.target === 'screen' && e.targetId === screen.id);

/**
 * The entries of `entries` that reach `screen`, as it gets them: by `order`, then id, without their target ids. The
 * screen ranks them by level itself; it never learns which other groups or screens exist.
 */
export function screenSchedule(entries: readonly TargetedEntry[], screen: ScheduleScreen): ScheduleEntry[] {
  return entries
    .filter((e) => reaches(e, screen))
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(({ targetId: _t, order: _o, ...e }) => e);
}
