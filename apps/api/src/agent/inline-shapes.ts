/**
 * What `POST /api/agent/inline` takes and answers (#263), shared with the CMS: a flyer or photo as
 * base64 JPEG, PNG or WebP that the browser scaled down, or the link a person pasted; and the spot
 * it made, with a mark for each field the fill was about; or, for a spot that exists (#264), the
 * change it would make, which `POST /api/agent/inline/keep` writes once the person keeps it. Types,
 * constants and the list rows' matching, which the route and the CMS's summary share, so the CMS
 * imports it without the API's code or schemas; the route parses a request with its own (./inline.ts).
 */
import type { ListItemFieldDef } from '@signforge/contract';
import type { SpotView } from '@signforge/tools/outputs';

/** The image types a fill takes: what the browser's scaling makes, and what both providers read. */
export const FILL_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/**
 * The most a photo may be once decoded. The browser scales it to `FILL_IMAGE_EDGE` first, which
 * leaves a flyer a few hundred kB, so the route reads it without decoding it inside the Free plan's
 * 10 ms of CPU.
 */
export const FILL_IMAGE_MAX_BYTES = 1_500_000;

/** The longest edge the browser scales a photo to: what a model reads in full detail without scaling it again. */
export const FILL_IMAGE_EDGE = 1568;

type Source = { kind: 'image'; mediaType: (typeof FILL_IMAGE_TYPES)[number]; data: string } | { kind: 'link'; url: string };

/**
 * A fill's request: the photo or the link, and for a new spot the template to fill when the person
 * picks it (Try another template); or, with `spotId`, the spot to update (#264), which writes nothing.
 */
export type InlineRequest = { source: Source; templateVersionId?: string; idempotencyKey: string } | { source: Source; spotId: string };

/**
 * The change a fill would make to a spot that exists (#264): its whole `data` as Keep would write it,
 * against the draft at `version`, and the fields' marks. Nothing is written until the person keeps it.
 */
export interface InlineReview {
  review: {
    spotId: string;
    version: number;
    /** The draft's data at `version`, which the change is shown against and Undo puts back. */
    before: Record<string, unknown>;
    data: Record<string, unknown>;
    marks: Record<string, FieldMark>;
  };
}

/** Keep (#264): the review's `data`, written to the spot at `ifVersion` and refused if it moved on since. */
export interface KeepRequest {
  spotId: string;
  ifVersion: number;
  data: Record<string, unknown>;
}

type Row = Record<string, unknown>;

/** The column a list's rows are told apart by: its first text column, as a menu's item name; undefined for a list with none. */
export function keyColumn(item: Record<string, ListItemFieldDef>): string | undefined {
  return Object.entries(item).find(([, d]) => d.type === 'text')?.[0];
}

/** A row's key, as people tell items apart: the key column's text, trimmed, in any case. Empty for none. */
export const rowKey = (row: Row, column: string) => {
  const v = row[column];
  return typeof v === 'string' ? v.trim().toLocaleLowerCase() : '';
};

/**
 * The rows of `after` matched with those of `before` (#264): by key, each before row at most once, or
 * by place in a list with no text column. A row of `after` with no match is added; one of `before`
 * left over is removed. Indexes into each list.
 */
export function matchRows(item: Record<string, ListItemFieldDef>, before: Row[], after: Row[]) {
  const column = keyColumn(item);
  const pairs: [number, number][] = [];
  const added: number[] = [];
  const queues = new Map<string, number[]>();
  if (column) before.forEach((row, i) => queues.set(rowKey(row, column), [...(queues.get(rowKey(row, column)) ?? []), i]));
  after.forEach((row, j) => {
    const i = column ? (rowKey(row, column) ? queues.get(rowKey(row, column))?.shift() : undefined) : j < before.length ? j : undefined;
    if (i === undefined) added.push(j);
    else pairs.push([i, j]);
  });
  const paired = new Set(pairs.map(([i]) => i));
  return { pairs, added, removed: before.map((_, i) => i).filter((i) => !paired.has(i)) };
}

/**
 * A field the fill was about: `filled` from the material, `check` a guess or a link to read before
 * use, `missing` not in the material, or a value the template did not take. A link is never
 * written: it is shown, in full, for the person to check and add.
 */
export interface FieldMark {
  state: 'filled' | 'check' | 'missing';
  note?: string;
  links?: string[];
}

/** Why a fill did not run, in a word; `message` says it in a sentence. */
export type InlineProblem =
  | 'invalid_input'
  | 'forbidden'
  | 'no_model'
  | 'cannot_fill'
  | 'out_of_turns'
  | 'rate_limited'
  | 'conflict'
  | 'blocked'
  | 'page_refused'
  | 'unreachable'
  | 'unreadable'
  | 'model_refused'
  | 'busy';

export interface InlineAnswer {
  /** The new spot, as `create_spot` gave it. */
  spot: SpotView;
  marks: Record<string, FieldMark>;
}
