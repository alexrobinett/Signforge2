/**
 * The playlist tools' outputs as the CMS reads them (`list_playlists`, `get_playlist` in
 * packages/tools, the source of truth), and what the editor shows about a playlist: its loop
 * length and its transition in words.
 */
import type { Transition } from '@signforge/contract';
import type { SpotView } from './spots';

/** One playlist's draft, as `get_playlist` returns it. */
export interface PlaylistView {
  id: string;
  name: string;
  transition: Transition;
  spotIds: string[];
  version: number;
  /** The default playlist: every screen plays it when no schedule entry says otherwise. */
  isDefault: boolean;
  published: boolean;
  draftChanged: boolean;
  publishedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** What the editor edits: the parts of a playlist's draft a person changes. */
export interface PlaylistDraft {
  name: string;
  transition: Transition;
  spotIds: string[];
}

export const playlistDraftOf = (p: PlaylistView): PlaylistDraft => ({ name: p.name, transition: p.transition, spotIds: p.spotIds });

/**
 * How long one pass of the loop takes. The player holds each spot for its full duration and
 * starts the next one's clock when a transition begins (packages/player, `show`), so a transition
 * overlaps the spot before it and adds nothing.
 */
export const loopMs = (spotIds: string[], spots: Map<string, SpotView>) => spotIds.reduce((ms, id) => ms + (spots.get(id)?.durationMs ?? 0), 0);

/**
 * A key for each row of the order: the spot and which of its occurrences this is (`spt_1#0`,
 * `spt_1#1`), so a row keeps its key, and its focus, when it moves.
 */
export function rowKeys(spotIds: string[]): string[] {
  const seen = new Map<string, number>();
  return spotIds.map((id) => {
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    return `${id}#${n}`;
  });
}

/** A length as a clock reads it: `45 s`, `2:05`, `1:02:05`. */
export function clockLength(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** The transition in a few words, for the list. */
export const transitionWord = (t: Transition) => (t.type === 'cut' ? 'Cut' : `${t.type === 'fade' ? 'Fade' : 'Crossfade'} ${t.ms / 1000} s`);

/** Whether screens have it, in words. */
export const playlistPublishWord = (p: Pick<PlaylistView, 'published' | 'draftChanged'>) =>
  !p.published ? 'Draft, never published' : p.draftChanged ? 'Published, with unpublished changes' : 'Published';
