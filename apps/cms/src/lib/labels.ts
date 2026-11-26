/**
 * Screen labels in the CMS (#185): a screen's `key=value` facts, as `update_screen_labels` sets them and
 * `list_label_keys` counts them. Values compare as the selector module folds them (trimmed, case-insensitive), so the
 * page and a publish agree on what is the same value.
 */
import { foldValue } from '@signforge/compiler/selector';
import type { ToolOutput } from '@signforge/tools/outputs';

/** One key and its values across the org's screens, as `list_label_keys` counts them. */
export type LabelKey = ToolOutput<'list_label_keys'>['keys'][number];

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
