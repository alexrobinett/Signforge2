/**
 * What an update from a flyer, photo or link would change in a spot (#264), in words for its review:
 * each field whose value differs, and for a list its rows changed, added and removed, matched as the
 * API matches them (`matchRows`, by the first text column). It is worked out from exactly the data
 * Keep writes and the draft it was made on, so the review shows all of the change and nothing else.
 *
 * And where else a changed row is (`alsoOn`): another template spot with a list row of the same name,
 * the latte on the lunch menu too, and that spot's data with the same columns changed, for the same review.
 */
import { keyColumn, matchRows, rowKey } from '@signforge/api/agent-inline';
import type { FieldDef, ScalarFieldDef } from '@signforge/contract';
import type { SpotView, TemplateVersionView } from './spots';

type Row = Record<string, unknown>;

/** A value as the review writes it. */
const shown = (v: unknown) => (v === undefined || v === null || v === '' ? '(empty)' : typeof v === 'string' ? v : JSON.stringify(v));

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const rowsOf = (v: unknown): Row[] => (Array.isArray(v) ? v.filter((r): r is Row => typeof r === 'object' && r !== null && !Array.isArray(r)) : []);

/** A row in words: its text, number and choice cells, as a person reads a menu line. */
const rowText = (item: Record<string, ScalarFieldDef>, row: Row) =>
  Object.entries(item)
    .filter(([k, d]) => ['text', 'number', 'select'].includes(d.type) && row[k] !== '' && row[k] !== undefined)
    .map(([k]) => shown(row[k]))
    .join(' · ');

export type FieldChange =
  | { field: string; label: string; kind: 'value'; before: string; after: string }
  | {
      field: string;
      label: string;
      kind: 'rows';
      changed: { name: string; key: string; cells: { label: string; before: string; after: string }[] }[];
      added: string[];
      removed: string[];
    };

export function fillChanges(fields: Record<string, FieldDef>, before: Record<string, unknown>, after: Record<string, unknown>): FieldChange[] {
  return Object.entries(fields).flatMap(([field, def]): FieldChange[] => {
    if (same(before[field], after[field])) return [];
    if (def.type !== 'list') return [{ field, label: def.label, kind: 'value', before: shown(before[field]), after: shown(after[field]) }];
    const was = rowsOf(before[field]);
    const now = rowsOf(after[field]);
    const { pairs, added, removed } = matchRows(def.item, was, now);
    const column = keyColumn(def.item);
    const changed = pairs.flatMap(([i, j]) => {
      const a = was[i] ?? {};
      const b = now[j] ?? {};
      const cells = Object.entries(def.item)
        .filter(([k]) => !same(a[k], b[k]))
        .map(([k, d]) => ({ label: d.label, before: shown(a[k]), after: shown(b[k]) }));
      return cells.length ? [{ name: column ? shown(a[column]) : `Row ${i + 1}`, key: column ? rowKey(a, column) : '', cells }] : [];
    });
    return [
      {
        field,
        label: def.label,
        kind: 'rows',
        changed,
        added: added.map((j) => rowText(def.item, now[j] ?? {})),
        removed: removed.map((i) => rowText(def.item, was[i] ?? {})),
      },
    ];
  });
}

/** Another spot with a row the update changes, and its data with the same columns changed. */
export interface AlsoOn {
  spotId: string;
  name: string;
  items: string[];
  version: number;
  before: Record<string, unknown>;
  data: Record<string, unknown>;
}

/**
 * The org's other template spots with a list row named as a row this update changes (`changes`'
 * `changed`), each with its data as the same review would leave it: in each such row, every column
 * the changed row changed that this spot's row has too. Rows added or removed are this spot's own.
 */
export function alsoOn(
  spotId: string,
  fields: Record<string, FieldDef>,
  after: Record<string, unknown>,
  changes: FieldChange[],
  spots: SpotView[],
  versions: Map<string, TemplateVersionView>,
): AlsoOn[] {
  // The changed rows, by key: their new values, as the update leaves them.
  const updated = new Map<string, Row>();
  for (const c of changes) {
    if (c.kind !== 'rows') continue;
    const def = fields[c.field];
    const column = def?.type === 'list' ? keyColumn(def.item) : undefined;
    if (!column) continue;
    for (const row of rowsOf(after[c.field])) if (c.changed.some((x) => x.key === rowKey(row, column))) updated.set(rowKey(row, column), row);
  }
  if (!updated.size) return [];
  return spots.flatMap((spot): AlsoOn[] => {
    const theirs = versions.get(spot.templateVersionId ?? '')?.manifest.fields;
    if (spot.id === spotId || spot.kind !== 'template' || !theirs || !spot.data) return [];
    const data: Record<string, unknown> = { ...spot.data };
    const items: string[] = [];
    for (const [field, def] of Object.entries(theirs)) {
      const column = def.type === 'list' ? keyColumn(def.item) : undefined;
      // A field its data source fills is the source's to change.
      if (def.type !== 'list' || !column || spot.bindings?.[field]) continue;
      data[field] = rowsOf(spot.data[field]).map((row) => {
        const now = updated.get(rowKey(row, column));
        if (!now) return row;
        const next = Object.fromEntries(
          Object.entries(row).map(([k, v]) => [k, k !== column && k in now && ['text', 'number', 'select'].includes(def.item[k]?.type ?? '') ? now[k] : v]),
        );
        if (!same(next, row)) items.push(shown(row[column]));
        return next;
      });
    }
    return items.length ? [{ spotId: spot.id, name: spot.name, items, version: spot.version, before: spot.data, data }] : [];
  });
}
