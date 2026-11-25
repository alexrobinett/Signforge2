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
import { type Binding, boundValue, isNewsImage, missingColumns, readPath, type DataSnapshot, type ScreenManifest, type Spot } from '@signforge/contract';

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

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: unknown, k: string): unknown => (isObj(o) && Object.hasOwn(o, k) ? o[k] : undefined);

/** Image property names declared on a list field's `item`, and its `maxItems`, if `def` is such a list. */
function listImageDef(fields: unknown, field: string): { props: string[]; maxItems?: number } | undefined {
  const def = own(fields, field);
  if (!isObj(def) || def.type !== 'list' || !isObj(def.item)) return undefined;
  const props = Object.entries(def.item).flatMap(([k, d]) => (isObj(d) && d.type === 'image' ? [k] : []));
  if (!props.length) return undefined;
  return { props, ...(typeof def.maxItems === 'number' && def.maxItems > 0 ? { maxItems: def.maxItems } : {}) };
}

/** Whether any bound field in `bound` is a non-table list whose items declare an `image` property. */
export function hasBoundListImage(bound: readonly BoundField[]): boolean {
  return bound.some((b) => !b.binding.table && listImageDef(b.fields, b.field) !== undefined);
}

/**
 * Every `NewsImage` blob hash (`file` and `thumb`) referenced by `bound`'s list-image fields in
 * snapshot `data`, in story order, deduplicated.
 */
export function boundImageHashes(bound: readonly BoundField[], data: unknown): string[] {
  const seen = new Set<string>();
  for (const b of bound) {
    if (b.binding.table) continue;
    const def = listImageDef(b.fields, b.field);
    if (!def) continue;
    const raw = readPath(data, b.binding.path);
    if (!Array.isArray(raw)) continue;
    const rows = def.maxItems ? raw.slice(0, def.maxItems) : raw;
    for (const row of rows) {
      for (const prop of def.props) {
        const img = own(row, prop);
        if (!isNewsImage(img)) continue;
        seen.add(img.file);
        seen.add(img.thumb);
      }
    }
  }
  return [...seen];
}

function collectSnapshotFiles(bySource: Map<string, BoundField[]>, snapshots: ReadonlyMap<string, DataSnapshot>, out: Set<string>): void {
  for (const [sourceId, bound] of bySource) {
    if (!hasBoundListImage(bound)) continue;
    const snap = snapshots.get(sourceId);
    if (!snap) continue;
    for (const sha of boundImageHashes(bound, snap.data)) out.add(sha);
  }
}

/**
 * Every feed-image blob hash referenced by `snapshots` for any list-image field bound in
 * `manifests`. Used by the player to pin held snapshot images and by preview to gather them.
 */
export function manifestSnapshotFiles(manifests: readonly (ScreenManifest | undefined)[], snapshots: ReadonlyMap<string, DataSnapshot>): Set<string> {
  const out = new Set<string>();
  for (const m of manifests) if (m) collectSnapshotFiles(manifestBoundFields(m), snapshots, out);
  return out;
}

/** Feed-image blob hashes referenced by `spot`'s bound sources' held snapshots. */
export function spotSnapshotFiles(spot: Spot, manifest: ScreenManifest, snapshots: ReadonlyMap<string, DataSnapshot>): Set<string> {
  const out = new Set<string>();
  if (spot.kind !== 'template' || !spot.bindings) return out;
  const fields = manifest.templates[spot.template]?.manifest.fields;
  collectSnapshotFiles(boundFields([{ id: spot.id, fields, bindings: spot.bindings }], [screenLocale(manifest)]), snapshots, out);
  return out;
}
