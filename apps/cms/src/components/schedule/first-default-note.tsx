/**
 * Before a publish from the Schedule's dialogs, when the org has no default playlist (#243): the
 * publish makes the playlist it plays the default (the `publish` tool's `madeDefault`), since
 * without one no screen can be published to. Said before it happens.
 */
import type { PlaylistView } from '~/lib/playlists';

export function FirstDefaultNote({ playlists, playlistId, action }: { playlists: PlaylistView[]; playlistId: string; action: string }) {
  const chosen = playlists.find((p) => p.id === playlistId);
  if (!chosen || playlists.some((p) => p.isDefault)) return null;
  return (
    <p className="rounded-md border border-status-updating bg-status-updating-muted px-3 py-2 text-sm text-status-updating-foreground">
      This organization has no default playlist yet. {action} makes <bdi>{chosen.name}</bdi> the default: every screen plays it when nothing is scheduled.
      Change it later with Play on every screen on another playlist.
    </p>
  );
}
