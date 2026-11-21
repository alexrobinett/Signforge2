/**
 * Bound fields: which fields a data source feeds, and whether a snapshot of it may replace the
 * last good one. One rule for the player (as it keeps a snapshot), the API's sync (as it sends
 * one, from the screen's manifest) and the poller (as it stores one, from the org's published
 * spots). Each value is checked as the contract's `boundValue` checks it when a spot plays, in the
 * locale a screen writes numbers and sorts rows in.
 *
 * A snapshot is kept when nothing binds to its source, or when it fills at least one bound field
 * and, if it is a table, has every column a table binding maps: a renamed or dropped column is a
 * person's edit, and the last good rows stay on screen until it is put right, rather than that
 * spot falling back to its static values while the others take the new data.
 */
import { type Binding, boundValue, missingColumns, readPath, type ScreenManifest } from '@signforge/contract';

/** The locale a screen with none set plays in. */
export const PLAYER_LOCALE = 'en-US';

/** The locale a manifest's screen plays in. */
export const screenLocale = (m: ScreenManifest): string => m.screen.locale ?? PLAYER_LOCALE;

/** A template spot as its bound fields are read: its id, its template's field definitions, and its bindings. */
export interface BindingSpot {
  id: string;
  fields: unknown;
  bindings: Readonly<Record<string, Binding>> | undefined;
}

/** One field a spot binds to a source, and the locales screens play it in: it fits if it fits in one of them. */
export interface BoundField {
  spot: string;
  field: string;
  binding: Binding;
  fields: unknown;
  locales: readonly string[];
}

/** The fields `spots` bind, by source, each played in `locales`. */
export function boundFields(spots: Iterable<BindingSpot>, locales: readonly string[]): Map<string, BoundField[]> {
  const out = new Map<string, BoundField[]>();
  for (const spot of spots)
    for (const [field, binding] of Object.entries(spot.bindings ?? {}))
      out.set(binding.source, [...(out.get(binding.source) ?? []), { spot: spot.id, field, binding, fields: spot.fields, locales }]);
  return out;
}

/** The fields a manifest's template spots bind, by source, in its screen's locale. */
export function manifestBoundFields(m: ScreenManifest): Map<string, BoundField[]> {
  const spots = Object.values(m.spots).flatMap((s) =>
    s.kind === 'template' ? [{ id: s.id, fields: m.templates[s.template]?.manifest.fields, bindings: s.bindings }] : [],
  );
  return boundFields(spots, [screenLocale(m)]);
}

/** Whether a snapshot's data may replace its source's last good one (`refused` null), and what is wrong with it. */
export function snapshotFit(bound: readonly BoundField[], data: unknown): { refused: 'unfit' | 'missing-column' | null; problems: string[] } {
  const problems: string[] = [];
  let fits = 0;
  for (const b of bound) {
    // Checked in each locale until it fits; its problems are those of the locale it fits in, or of the first.
    let found: ReturnType<typeof boundValue> | undefined;
    for (const locale of b.locales) {
      const r = boundValue(b.fields, b.field, b.binding, data, locale);
      if (!found || r.value !== undefined) found = r;
      if (r.value !== undefined) break;
    }
    problems.push(...(found?.problems ?? []).map((e) => `spot "${b.spot}": ${e}`));
    if (found?.value !== undefined) fits++;
  }
  const columns = readPath(data, 'columns');
  if (Array.isArray(columns) && bound.some((b) => b.binding.table && missingColumns(columns, b.binding.table).length > 0))
    return { refused: 'missing-column', problems };
  return { refused: bound.length && !fits ? 'unfit' : null, problems };
}
