/**
 * The screen tools' outputs as the CMS reads them (`list_screens`, `list_screen_status`,
 * `get_screen`, `list_groups`), typed by the tools' own output schemas.
 */
import { displayHoursProblems } from '@signforge/contract';
import type { ToolOutput } from '@signforge/tools/outputs';

export type ScreenView = ToolOutput<'list_screens'>['screens'][number];

export type StateKind = ScreenView['state']['kind'];
/** The states in the order the page lists them; `satisfies` keeps it to the tools' own. */
export const STATE_KINDS = ['online', 'updating', 'asleep', 'unreachable', 'needs_you'] as const satisfies readonly StateKind[];

/** Whether a value read from a URL or a select is one of the states. */
export const isStateKind = (v: unknown): v is StateKind => STATE_KINDS.some((k) => k === v);

/** Whether a value read from a select is an orientation. */
export const isOrientation = (v: unknown): v is 'landscape' | 'portrait' => v === 'landscape' || v === 'portrait';

export type DisplayHours = NonNullable<ScreenView['displayHours']>;

/** What `list_screen_status` gives of a screen: what it is doing, for the Screens page's poll. */
export type ScreenStatus = ToolOutput<'list_screen_status'>['screens'][number];

export type GroupView = ToolOutput<'list_groups'>['groups'][number];

/** Why display hours would be refused, as the player checks them (the contract's `displayHoursProblems`), and a window with no day. */
export function hoursProblems(hours: DisplayHours | null): string[] {
  if (!hours) return [];
  const problems = displayHoursProblems(hours);
  if (hours.weekly.some((w) => w.days.length === 0)) problems.push('every window needs at least one day');
  return problems;
}
