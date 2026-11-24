/**
 * Overview, the first page after sign-in (#357): what needs the member, what screens play, the
 * drafts not published yet, and a new org's setup checklist (#334), each worked out from the tools'
 * own lists, so a step ticks itself off once the data says it is done.
 */
import { isBaseTemplateKey } from '@signforge/contract';
import { isRetired } from './screen-status';
import type { PlaylistView } from './playlists';
import type { ScheduleEntryView } from './schedule';
import type { ScreenView } from './screen-types';
import type { SpotView } from './spots';
import thumbnails from './template-thumbnails.json';

type Spot = Pick<SpotView, 'id' | 'name' | 'kind' | 'published' | 'draftChanged' | 'updatedAt'>;
type Playlist = Pick<PlaylistView, 'id' | 'name' | 'spotIds' | 'isDefault' | 'published' | 'draftChanged' | 'updatedAt'>;
type Entry = Pick<ScheduleEntryView, 'id' | 'playlistId' | 'takeover' | 'deleted' | 'published' | 'draftChanged' | 'updatedAt'>;

export type SetupStep = 'spot' | 'default' | 'screen';

/**
 * The setup steps, in order, and whether each is done: a spot made from a template; a playlist
 * with a spot in it that is the default, which every screen plays; a screen paired (the browser
 * test screen counts). A retired screen plays nothing, so it does not count.
 */
export function setupSteps(d: {
  spots: readonly Spot[];
  playlists: readonly Playlist[];
  screens: readonly Pick<ScreenView, 'state'>[];
}): Record<SetupStep, boolean> {
  return {
    spot: d.spots.some((s) => s.kind === 'template'),
    default: d.playlists.some((p) => p.isDefault && p.spotIds.length > 0),
    screen: d.screens.some((s) => !isRetired(s)),
  };
}

export interface Unpublished {
  kind: 'spot' | 'playlist' | 'entry';
  id: string;
  name: string;
  /** What screens have of it, in words. */
  word: string;
  updatedAt: number;
}

const wordOf = (d: { published: boolean; deleted?: boolean }) =>
  d.deleted ? 'removed, not published' : d.published ? 'changes not published' : 'never published';

/** Every spot, playlist and schedule entry whose draft differs from what screens have, newest edit first. */
export function unpublished(d: { spots: readonly Spot[]; playlists: readonly Playlist[]; entries: readonly Entry[] }): Unpublished[] {
  const playlistName = new Map(d.playlists.map((p) => [p.id, p.name]));
  return [
    ...d.spots.filter((s) => s.draftChanged).map((s): Unpublished => ({ kind: 'spot', id: s.id, name: s.name, word: wordOf(s), updatedAt: s.updatedAt })),
    ...d.playlists
      .filter((p) => p.draftChanged)
      .map((p): Unpublished => ({ kind: 'playlist', id: p.id, name: p.name, word: wordOf(p), updatedAt: p.updatedAt })),
    ...d.entries
      .filter((e) => e.draftChanged)
      .map(
        (e): Unpublished => ({
          kind: 'entry',
          id: e.id,
          name: `${e.takeover ? 'Takeover' : 'Schedule'}: ${playlistName.get(e.playlistId) ?? 'a deleted playlist'}`,
          word: wordOf(e),
          updatedAt: e.updatedAt,
        }),
      ),
  ].toSorted((a, b) => b.updatedAt - a.updatedAt);
}

const THUMBNAILS: Record<string, string> = thumbnails;

/** A base template's thumbnail, drawn by the player (scripts/template-thumbnails.ts), from its key (`base/clock@1.2.4`); null for an org's own template. */
export function templateThumbnail(key: string): string | null {
  if (!isBaseTemplateKey(key)) return null;
  const id = key.slice('base/'.length, key.lastIndexOf('@'));
  return id in THUMBNAILS ? `/template-thumbnails/${id}.webp` : null;
}

export interface Playing {
  spot: NonNullable<NonNullable<ScreenView['showing']>['spot']>;
  playlist: string | null;
  screens: number;
}

/**
 * What the awake screens should be showing now, one row per first spot, the most screens first.
 * Asleep and retired screens play nothing, so they are left out.
 */
export function playingNow(screens: readonly Pick<ScreenView, 'showing' | 'state'>[]): Playing[] {
  const bySpot = new Map<string, Playing>();
  for (const s of screens) {
    const spot = s.showing?.spot;
    if (!spot || s.showing?.asleep || isRetired(s)) continue;
    const row = bySpot.get(spot.id);
    if (row) row.screens += 1;
    else bySpot.set(spot.id, { spot, playlist: s.showing?.playlist?.name ?? null, screens: 1 });
  }
  return [...bySpot.values()].toSorted((a, b) => b.screens - a.screens || a.spot.name.localeCompare(b.spot.name));
}
