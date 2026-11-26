/**
 * Screen labels in the CMS (#185): a screen's `key=value` facts, as `update_screen_labels` sets them and
 * `list_label_keys` counts them. Values compare as the selector module folds them (trimmed, case-insensitive), so the
 * page and a publish agree on what is the same value.
 */
import { foldValue } from '@signforge/compiler/selector';
import type { ToolOutput } from '@signforge/tools/outputs';
import { shownAs } from './label-filter';

/** One key and its values across the org's screens, as `list_label_keys` counts them. */
export type LabelKey = ToolOutput<'list_label_keys'>['keys'][number];

/**
 * The most screens one `update_screen_labels` changes, as the tool's input takes them (packages/tools/src/labels.ts).
 * A bulk change to more is refused whole, so the dialog says so before sending rather than in parts (#605): split
 * parts would lose the change's all-or-nothing write.
 */
export const MAX_BULK_SCREENS = 1000;

/** One label as an editor holds it: what is typed, untrimmed, until it is saved. */
export interface LabelRow {
  key: string;
  value: string;
}

/** A screen's labels as rows, by key. */
export const labelRows = (labels: Readonly<Record<string, string>>): LabelRow[] =>
  Object.entries(labels)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => ({ key, value }));

/**
 * The labels `rows` hold, trimmed: a key is lowercased, as every key is, and a row with no key or no value is left
 * out, as one being typed. Of two rows with one key, the later stands.
 */
export function labelsOf(rows: readonly LabelRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const key = r.key.trim().toLowerCase();
    const value = r.value.trim();
    if (key && value) out[key] = value;
  }
  return out;
}

/**
 * Why each row cannot be saved as it is, by row (undefined for one that can): a key another row has too, once
 * lowercased, as every key is; a key with no value; a value with no key. An empty row is one not typed in yet. Until
 * none has one, the editor saves nothing, so no row is lost without a word (review of #597).
 */
export function labelProblems(rows: readonly LabelRow[]): (string | undefined)[] {
  const keys = rows.map((r) => r.key.trim().toLowerCase());
  return rows.map((r, i) => {
    const key = keys[i]!;
    const value = r.value.trim();
    if (!key && !value) return undefined;
    if (!key) return 'Give it a key, or remove the row.';
    if (!value) return `${key}: give it a value, or remove the row.`;
    if (keys.indexOf(key) !== i) return `${key}: another row has this key. Keep one.`;
    return undefined;
  });
}

/** Whether every row can be saved as it is. */
export const labelsReady = (rows: readonly LabelRow[]) => labelProblems(rows).every((p) => p === undefined);

/** What turns `before` into what `rows` hold, as `update_screen_labels` takes it; null when nothing changes. */
export function labelChange(before: Readonly<Record<string, string>>, rows: readonly LabelRow[]): { set: Record<string, string>; remove: string[] } | null {
  const after = labelsOf(rows);
  const set = Object.fromEntries(Object.entries(after).filter(([k, v]) => before[k] !== v));
  const remove = Object.keys(before).filter((k) => !Object.hasOwn(after, k));
  return Object.keys(set).length || remove.length ? { set, remove } : null;
}

/**
 * A typo guard: the warning for `row` when its value is on no other screen (`nrth: no other screen has this value`),
 * or undefined. `own` is the screen's labels as saved, so its own value does not count for itself; a new key warns
 * nothing, as every value of it is new.
 */
export function lonelyValue(keys: readonly LabelKey[], row: LabelRow, own: Readonly<Record<string, string>> = {}): string | undefined {
  const key = row.key.trim().toLowerCase();
  const value = row.value.trim();
  const known = keys.find((k) => k.key === key && !k.system);
  if (!value || !known) return undefined;
  const mine = own[key] !== undefined && foldValue(own[key]) === foldValue(value) ? 1 : 0;
  const others = (known.values.find((v) => foldValue(v.value) === foldValue(value))?.screens ?? 0) - mine;
  return others > 0 ? undefined : `${value}: no other screen has this value`;
}

/** One key across a selection: each value with how many of the screens have it (folded, named as most spell it), and how many have none. */
export interface KeyAcross {
  key: string;
  values: { value: string; screens: number }[];
  none: number;
}

/**
 * The selection's labels by key, as the bulk dialog lists them: "region: north (6), south (2), none (4)". Values
 * compare as selectors fold them; each is named as most of the screens spell it, then in code-unit order.
 */
export function labelsAcross(screens: readonly { labels: Readonly<Record<string, string>> }[]): KeyAcross[] {
  const by = new Map<string, Map<string, Map<string, number>>>();
  for (const s of screens)
    for (const [key, value] of Object.entries(s.labels)) {
      const values = by.get(key) ?? new Map<string, Map<string, number>>();
      by.set(key, values);
      const spellings = values.get(foldValue(value)) ?? new Map<string, number>();
      values.set(foldValue(value), spellings.set(value, (spellings.get(value) ?? 0) + 1));
    }
  return [...by.keys()]
    .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => {
      const values = [...by.get(key)!.values()]
        .map((spellings) => ({
          value: shownAs(spellings),
          screens: [...spellings.values()].reduce((x, y) => x + y, 0),
        }))
        .toSorted((a, b) => b.screens - a.screens || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
      return { key, values, none: screens.length - values.reduce((n, v) => n + v.screens, 0) };
    });
}

/** "north (6), south (2), none (4)": a key across a selection, in words. */
export const acrossWords = ({ values, none }: KeyAcross) => [...values.map((v) => `${v.value} (${v.screens})`), ...(none ? [`none (${none})`] : [])].join(', ');
