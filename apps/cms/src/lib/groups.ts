/**
 * Screen groups as the CMS shows them: which need a person (the Screens page's Needs attention),
 * and what targets one (the Groups list in Settings, Screens & groups).
 */
import type { BrandKitView } from './brand-kits';
import type { ScheduleEntryView } from './schedule';
import { isRetired } from './screen-status';
import type { GroupView, ScreenView } from './screen-types';

/** The groups with a screen that needs you, each with those screens. A retired screen needs nobody. */
export function needingAttention(groups: readonly GroupView[], screens: readonly ScreenView[]) {
  const needs = new Map(screens.filter((s) => s.state.kind === 'needs_you' && !isRetired(s)).map((s) => [s.id, s]));
  return groups.flatMap((group) => {
    const of = group.screenIds.flatMap((id) => needs.get(id) ?? []);
    return of.length ? [{ group, needs: of }] : [];
  });
}

/** A takeover whose end has passed, as drafted and as screens have it: it plays nowhere again. */
const ended = (e: ScheduleEntryView, now: number) => {
  const over = (end: string | null) => end !== null && Date.parse(end) <= now;
  return e.takeover && over(e.endsAt) && (!e.live || over(e.live.endsAt));
};

/** What targets a group: the schedule entries aimed at it, as `delete_group` counts them, and the brand kits it chose. */
export function targetsOf(groupId: string, entries: readonly ScheduleEntryView[], kits: readonly BrandKitView[], now: number) {
  return {
    entries: entries.filter((e) => e.target === 'group' && e.groupId === groupId && !ended(e, now)),
    kits: kits.filter((k) => k.groupIds.includes(groupId)),
  };
}
