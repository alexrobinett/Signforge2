/**
 * Overview, the first page after sign-in (#357): what needs the member, what screens play, the
 * drafts not published yet, and a new org's setup checklist (#334). Each is worked out from the
 * tools' answers, so a step ticks itself off once the data says it is done.
 */
import { isBaseTemplateKey } from '@signforge/contract';
import { isRetired } from './screen-status';
import type { PlaylistView } from './playlists';
import type { ScheduleEntryView } from './schedule';
import type { ScreenView } from './screen-types';
import type { SpotView } from './spots';
import thumbnails from './template-thumbnails.json';

/**
 * Overview's Query key (src/queries/overview.ts). Every save of a spot, playlist or schedule entry
 * invalidates it, so a draft made while Overview is open (the agent's drawer, ⌘K) shows there.
 */
export const overviewKey = (orgId: string) => ['org', orgId, 'overview'] as const;

/** How many drafts Overview names, newest edit first; the rest are counted. Its read asks each list tool for this many. */
export const SHOWN_DRAFTS = 5;

type Spot = Pick<SpotView, 'id' | 'name' | 'published' | 'updatedAt'>;
type Playlist = Pick<PlaylistView, 'id' | 'name' | 'published' | 'updatedAt'>;
type Entry = Pick<ScheduleEntryView, 'id' | 'takeover' | 'deleted' | 'published' | 'updatedAt'> & { playlistName: string | null };
type Screen = Pick<ScreenView, 'state' | 'desiredManifestId' | 'reportedManifestId'>;

/** Whether a screen has taken the publish meant for it: it reports playing the manifest it should. */
const tookPublish = (s: Screen) => s.desiredManifestId !== null && s.reportedManifestId === s.desiredManifestId;

export type SetupStep = 'spot' | 'default' | 'screen';

/**
 * The setup steps, in order, and whether each is done, as screens see it:
 *  - a spot made from a template;
 *  - a default playlist that is published with spots in it (a publish promotes a playlist only
 *    once every spot in it is published, so they are too);
 *  - with that, a screen (the browser test screen counts) that has taken a publish: it reports a
 *    manifest, and every manifest a publish compiles carries the default. It stays done while the
 *    screen is behind on a later publish (Needs you says so), so a finished checklist does not come
 *    back. A retired screen plays nothing, so it does not count.
 */
export function setupSteps(d: {
  templateSpot: boolean;
  defaultPlaylist: Pick<PlaylistView, 'published' | 'spotIds'> | null;
  screens: readonly Screen[];
}): Record<SetupStep, boolean> {
  const def = d.defaultPlaylist !== null && d.defaultPlaylist.published && d.defaultPlaylist.spotIds.length > 0;
  return {
    spot: d.templateSpot,
    default: def,
    screen: def && d.screens.some((s) => !isRetired(s) && s.reportedManifestId !== null),
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

/**
 * The drafts to name: the newest edits of the unpublished spots, playlists and schedule entries,
 * each list its tool's newest `SHOWN_DRAFTS`, so the newest of all three are among them.
 */
export function unpublished(d: { spots: readonly Spot[]; playlists: readonly Playlist[]; entries: readonly Entry[] }): Unpublished[] {
  return [
    ...d.spots.map((s): Unpublished => ({ kind: 'spot', id: s.id, name: s.name, word: wordOf(s), updatedAt: s.updatedAt })),
    ...d.playlists.map((p): Unpublished => ({ kind: 'playlist', id: p.id, name: p.name, word: wordOf(p), updatedAt: p.updatedAt })),
    ...d.entries.map(
      (e): Unpublished => ({
        kind: 'entry',
        id: e.id,
        // A playlist an entry plays cannot be deleted (`delete_playlist`), so a name is missing only if it went between two reads.
        name: `${e.takeover ? 'Takeover' : 'Schedule'}: ${e.playlistName ?? 'a playlist'}`,
        word: wordOf(e),
        updatedAt: e.updatedAt,
      }),
    ),
  ]
    .toSorted((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, SHOWN_DRAFTS);
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
 * What the screens are playing now, one row per first spot, the most screens first. Only screens
 * that have taken their publish count: what they report applying is the manifest `showing` is
 * worked out from. A screen still fetching it, or behind and unreachable (Needs you), is left
 * out, as are asleep and retired screens, which play nothing.
 */
export function playingNow(screens: readonly (Screen & Pick<ScreenView, 'showing'>)[]): Playing[] {
  const bySpot = new Map<string, Playing>();
  for (const s of screens) {
    const spot = s.showing?.spot;
    if (!spot || s.showing?.asleep || isRetired(s) || !tookPublish(s) || s.state.kind === 'needs_you') continue;
    const row = bySpot.get(spot.id);
    if (row) row.screens += 1;
    else bySpot.set(spot.id, { spot, playlist: s.showing?.playlist?.name ?? null, screens: 1 });
  }
  return [...bySpot.values()].toSorted((a, b) => b.screens - a.screens || a.spot.name.localeCompare(b.spot.name));
}
