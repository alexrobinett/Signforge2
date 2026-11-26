/**
 * Group membership (#186): a group of listed screens by its rows, a smart group by its rule over each screen's labels,
 * resolved by the compiler's `groupsOf`. Everything that asks which screens a group holds asks here, so a group means
 * the same screens to the publish, a takeover, a publish request, the takeover card and the brand kits.
 */
import { groupsOf, matches, systemLabels, type Selector } from '@signforge/compiler/selector';
import type { OrgScope, Screen, ScreenGroup } from '@signforge/db';
import type { z } from 'zod';
import { selector } from './fields';

/** Each screen's labels, by screen id: a screen without any is absent. */
export function labelsByScreen(rows: readonly { screenId: string; key: string; value: string }[]): Map<string, Record<string, string>> {
  const by = new Map<string, Record<string, string>>();
  for (const r of rows) by.set(r.screenId, { ...by.get(r.screenId), [r.key]: r.value });
  return by;
}

/** A group's rule, read as the tools check it where it went in; null for a group of listed screens. */
export const ruleOf = (g: Pick<ScreenGroup, 'selectorJson'>): z.infer<typeof selector> | null =>
  g.selectorJson === null ? null : selector.parse(JSON.parse(g.selectorJson));

/** Each screen's groups, from the org's rows as read: screens in no group are absent. */
export function resolveGroups(
  screens: readonly Screen[],
  labels: readonly { screenId: string; key: string; value: string }[],
  rules: readonly { id: string; selectorJson: string }[],
  members: readonly { groupId: string; screenId: string }[],
): Map<string, string[]> {
  const byScreen = labelsByScreen(labels);
  return groupsOf(
    screens.map((s) => ({ ...s, labels: byScreen.get(s.id) ?? {} })),
    rules.map((g) => ({ id: g.id, selector: ruleOf(g)! })),
    members,
  );
}

/** The org's groups, and each screen's, as they are now. */
export async function orgGroups(org: OrgScope) {
  const [screens, labels, groups, { members, rules }] = await Promise.all([
    org.screens.list(),
    org.screens.labels.list(),
    org.screenGroups.list(),
    org.screenGroups.membership(),
  ]);
  const of = resolveGroups(screens, labels, rules, members);
  /** The ids of the screens in `groupId`, sorted. */
  const screensIn = (groupId: string) => [...of].flatMap(([screenId, ids]) => (ids.includes(groupId) ? [screenId] : [])).toSorted();
  const byScreen = labelsByScreen(labels);
  /** The ids of the screens `rule` matches now, sorted: a rule not stored yet. */
  const matching = (rule: Selector) =>
    screens
      .filter((s) => matches(rule, { ...systemLabels(s), ...byScreen.get(s.id) }))
      .map((s) => s.id)
      .toSorted();
  return { screens, groups, groupsOf: of, screensIn, matching };
}
