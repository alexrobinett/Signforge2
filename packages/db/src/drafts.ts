/**
 * Drafts and published versions of spots, playlists and schedule entries.
 *
 * A row's own columns are the draft: every edit changes them. `published_json` holds the version
 * screens get, a copy of the draft's content taken when a publish promoted it (null until the
 * first). A playlist's copy includes its items, which live in `playlist_items` as a draft. Only
 * `stage.publish` (./scoped.ts) writes it; `NewRow` and `RowPatch` leave it out.
 */
import type * as s from './schema';

type SpotRow = typeof s.spots.$inferSelect;
type PlaylistRow = typeof s.playlists.$inferSelect;
type ScheduleEntryRow = typeof s.scheduleEntries.$inferSelect;
export type DraftRow = SpotRow | PlaylistRow | ScheduleEntryRow;

/** A playlist as published: its row as it was, and its spot ids in play order. */
export type PublishedPlaylist = PlaylistRow & { items: string[] };

/** Columns that are not content: who it is, when and how often it changed, and the published copy itself. */
// A spot's sample fields (#360) are the draft's bookkeeping, never published: they would make every
// spot published before them read as changed, and a publish allowed with them would carry them live.
const NOT_CONTENT = new Set([
  'id',
  'orgId',
  'createdAt',
  'updatedAt',
  'rowVersion',
  'incarnation',
  'publishedJson',
  'publishedAt',
  'publishedVersion',
  'sampleFieldsJson',
]);

/** The draft's content as stored in `published_json`. Keys sorted, so equal content is equal text. */
export function contentJson(row: DraftRow, items?: readonly string[]): string {
  const content: Record<string, unknown> = {};
  for (const key of Object.keys(row).sort()) if (!NOT_CONTENT.has(key)) content[key] = (row as Record<string, unknown>)[key];
  if (items) content.items = [...items];
  return JSON.stringify(content);
}

/** The published version of a row, shaped as the row; undefined if it was never published. */
export function published(row: PlaylistRow): PublishedPlaylist | undefined;
export function published<T extends DraftRow>(row: T): T | undefined;
export function published(row: DraftRow): DraftRow | undefined {
  if (row.publishedJson == null) return undefined;
  return { ...row, ...(JSON.parse(row.publishedJson) as object) };
}

/** Whether the draft differs from what is published (always, if nothing is). Pass a playlist's draft items. */
export const draftChanged = (row: DraftRow, items?: readonly string[]): boolean => row.publishedJson !== contentJson(row, items);
