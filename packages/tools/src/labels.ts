/**
 * Screen labels: `key=value` facts about a screen (`region=north`, `store=0142`), so a fleet is
 * described by facets rather than a group per facet. `list_screens({ selector })` picks screens by
 * them, with `@signforge/compiler/selector`; system labels come from the screen's settings.
 */
import { foldValue, systemLabels } from '@signforge/compiler/selector';
import { LABEL_LIMITS } from '@signforge/db';
import { z } from 'zod';
import { id, labelKey, labels } from './fields';
import { outputs } from './outputs';
import { page, pageInput } from './paging';
import { defineTool, ToolError } from './tool';

type LabelRow = { screenId: string; key: string; value: string };

/** Each screen's labels, by screen id: a screen without any is absent. */
export function labelsByScreen(rows: readonly LabelRow[]): Map<string, Record<string, string>> {
  const by = new Map<string, Record<string, string>>();
  for (const r of rows) by.set(r.screenId, { ...by.get(r.screenId), [r.key]: r.value });
  return by;
}

/** A merge into one screen's labels. */
type Change = { screenId: string; set: Readonly<Record<string, string>>; remove: readonly string[] };

/**
 * Why changes would give a screen more labels, or the org more keys, than `LABEL_LIMITS`, from the org's labels as
 * read (`rows`); undefined if they would not. The batch checks again as it commits (`labels.stage.update` and
 * `each`), in case another change lands in between.
 */
export function overLimit(rows: readonly LabelRow[], changes: readonly Change[]): ToolError | undefined {
  const by = new Map(changes.map((c) => [c.screenId, c]));
  const keysOf = new Map<string, Set<string>>();
  const add = (screenId: string, key: string) => keysOf.set(screenId, (keysOf.get(screenId) ?? new Set()).add(key));
  for (const r of rows) if (!by.get(r.screenId)?.remove.includes(r.key)) add(r.screenId, r.key);
  for (const c of changes) for (const key of Object.keys(c.set)) add(c.screenId, key);
  const crowded = [...by.keys()].filter((s) => (keysOf.get(s)?.size ?? 0) > LABEL_LIMITS.perScreen);
  if (crowded.length)
    return new ToolError('conflict', `a screen has at most ${LABEL_LIMITS.perScreen} labels; ${crowded.length} of these would have more`, {
      screenIds: crowded,
    });
  const keys = new Set([...keysOf.values()].flatMap((k) => [...k]));
  if (keys.size > LABEL_LIMITS.keys)
    return new ToolError(
      'conflict',
      `an organization's screens have at most ${LABEL_LIMITS.keys} label keys between them; this would make ${keys.size}. Reuse a key, or remove one no longer used`,
    );
  return undefined;
}

/** One change for each of `screenIds`, as `update_screen_labels` makes it. */
const forEach = (screenIds: readonly string[], change: { set: Readonly<Record<string, string>>; remove: readonly string[] }) =>
  screenIds.map((screenId) => ({ screenId, ...change }));

const change = z
  .object({
    screenIds: z.array(id('screen')).min(1).max(1000).describe('The screens to change, up to 1000'),
    set: labels.default({}).describe('Labels to set, by key: a key a screen has takes the new value'),
    remove: z.array(labelKey).default([]).describe('Keys to remove; a key a screen does not have is ignored'),
  })
  .refine((v) => Object.keys(v.set).length > 0 || v.remove.length > 0, 'give labels to set or keys to remove')
  .refine((v) => !v.remove.some((k) => Object.hasOwn(v.set, k)), 'a key cannot be both set and removed');

const updateScreenLabels = defineTool({
  name: 'update_screen_labels',
  description: `Set and remove labels on screens, as a merge: each key in set takes that value on every screen given, each key in remove goes, and the screens' other labels stay, so it is safe alongside other changes. Values are stored as typed and matched case-insensitively. A screen has at most ${LABEL_LIMITS.perScreen} labels, and an organization's screens at most ${LABEL_LIMITS.keys} keys between them (conflict past either). orientation, kind, timezone and locale are system labels, from the screen's settings, and cannot be set. A screen picks a label change up with the next publish. Returns { screens: [{ id, labels }] }, ordered by id.`,
  scope: 'screens:manage',
  minRole: 'editor',
  mutates: true,
  input: change,
  output: outputs.update_screen_labels,
  example: { screenIds: ['scr_example'], set: { region: 'north', type: 'drive-thru' }, remove: ['legacy'] },
  target: (input) => (new Set(input.screenIds).size === 1 ? { kind: 'screen', id: input.screenIds[0]! } : undefined),
  handler: async ({ org, input, write }) => {
    const screenIds = [...new Set(input.screenIds)].toSorted();
    const rows = await org.screens.labels.list();
    const over = overLimit(rows, forEach(screenIds, input));
    if (over) throw over;
    write(await org.screens.labels.stage.update(screenIds, input));
    const before = labelsByScreen(rows);
    return {
      screens: screenIds.map((s) => {
        const kept = Object.entries(before.get(s) ?? {}).filter(([k]) => !input.remove.includes(k));
        return { id: s, labels: { ...Object.fromEntries(kept), ...input.set } };
      }),
    };
  },
  refuseFailedCommit: async ({ org, input }) => overLimit(await org.screens.labels.list(), forEach([...new Set(input.screenIds)], input)),
});

const importScreenLabels = defineTool({
  name: 'import_screen_labels',
  description: `A label import (a CSV file in the CMS, #188): each screen its own merge, set and removed as update_screen_labels does, all written or none. Up to 1000 screens. For people only. Returns { screens: [{ id, labels }] }, ordered by id.`,
  scope: 'screens:manage',
  minRole: 'editor',
  mutates: true,
  // A file of a fleet's labels is a person's to send: an agent labels with update_screen_labels.
  people: true,
  input: z.object({
    screens: z
      .array(
        z
          .object({ screenId: id('screen'), set: labels.default({}), remove: z.array(labelKey).default([]) })
          .refine((c) => !c.remove.some((k) => Object.hasOwn(c.set, k)), 'a key cannot be both set and removed'),
      )
      .min(1)
      .max(1000)
      .refine((all) => new Set(all.map((c) => c.screenId)).size === all.length, 'each screen once'),
  }),
  output: outputs.import_screen_labels,
  example: { screens: [{ screenId: 'scr_example', set: { region: 'north' }, remove: ['legacy'] }] },
  // As update_screen_labels: one screen's import is in its events (review of #612).
  target: (input) => (input.screens.length === 1 ? { kind: 'screen', id: input.screens[0]!.screenId } : undefined),
  // The row's input lists the first 100 screens, as every audit row cuts a list; the count says how many it changed.
  auditDetail: (output) => ({ screenCount: output.screens.length }),
  handler: async ({ org, input, write }) => {
    const rows = await org.screens.labels.list();
    const over = overLimit(rows, input.screens);
    if (over) throw over;
    write(await org.screens.labels.stage.each(input.screens));
    const before = labelsByScreen(rows);
    return {
      screens: input.screens
        .map((c) => {
          const kept = Object.entries(before.get(c.screenId) ?? {}).filter(([k]) => !c.remove.includes(k));
          return { id: c.screenId, labels: { ...Object.fromEntries(kept), ...c.set } };
        })
        .toSorted((a, b) => (a.id < b.id ? -1 : 1)),
    };
  },
  refuseFailedCommit: async ({ org, input }) => overLimit(await org.screens.labels.list(), input.screens),
});

/** The spelling a value is shown in: the one most screens have, then the first in code-unit order. */
const shownAs = (spellings: Map<string, number>) => [...spellings].toSorted(([a, n], [b, m]) => m - n || (a < b ? -1 : a > b ? 1 : 0))[0]![0];

const listLabelKeys = defineTool({
  name: 'list_label_keys',
  description:
    "List the label keys the organization's screens use, each with its values and how many screens have each, so a selector can be built from what exists. Values that differ only in case or spaces are one value, shown as most screens spell it. System labels (orientation, kind, timezone, locale, from each screen's settings) are listed too, marked system. Returns { keys: [{ key, system, screens, values: [{ value, screens }] }], next }, keys in order, a page at a time, values by screens, most first; pass next as cursor for the following page.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ ...pageInput }),
  output: outputs.list_label_keys,
  example: {},
  handler: async ({ org, input }) => {
    const [rows, screens] = await Promise.all([org.screens.labels.list(), org.screens.list()]);
    // key -> folded value -> spelling -> screens
    const counts = new Map<string, { system: boolean; values: Map<string, Map<string, number>> }>();
    const count = (key: string, value: string, system: boolean) => {
      const k = counts.get(key) ?? { system, values: new Map() };
      counts.set(key, k);
      const spellings = k.values.get(foldValue(value)) ?? new Map<string, number>();
      k.values.set(foldValue(value), spellings.set(value, (spellings.get(value) ?? 0) + 1));
    };
    for (const r of rows) count(r.key, r.value, false);
    for (const s of screens) for (const [key, value] of Object.entries(systemLabels(s))) count(key, value, true);
    const keys = [...counts].map(([key, { system, values }]) => {
      const listed = [...values.values()]
        .map((spellings) => ({ value: shownAs(spellings), screens: [...spellings.values()].reduce((a, b) => a + b, 0) }))
        .toSorted((a, b) => b.screens - a.screens || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
      return { key, system, screens: listed.reduce((n, v) => n + v.screens, 0), values: listed };
    });
    const { rows: listed, next } = page(keys, (k) => [k.key], input);
    return { keys: listed, next };
  },
});

export const labelTools = [updateScreenLabels, listLabelKeys, importScreenLabels];
