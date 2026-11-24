/**
 * Before a publish from the Schedule's dialogs, when the org has no default playlist (#243): without
 * one no screen can be published to. An entry on every screen at all hours makes its playlist the
 * default as it publishes (the `publish` tool's `madeDefault`), and the dialog says so. For a takeover
 * or a narrower entry (owner decision) the dialog asks for one instead, prefilled with its playlist:
 * Save and publish, or Take over, makes it the default first (`set_default_playlist`).
 */
import { useId } from 'react';
import { NativeSelect } from '~/components/ui/select';
import type { PlaylistView } from '~/lib/playlists';

const BOX = 'rounded-md border border-status-updating bg-status-updating-muted px-3 py-2 text-sm text-status-updating-foreground';

/** For an entry on every screen at all hours: what its publish will do. */
export function FirstDefaultNote({ playlists, playlistId, action }: { playlists: PlaylistView[]; playlistId: string; action: string }) {
  const chosen = playlists.find((p) => p.id === playlistId);
  if (!chosen || playlists.some((p) => p.isDefault)) return null;
  return (
    <p className={BOX}>
      This organization has no default playlist yet. {action} makes <bdi>{chosen.name}</bdi> the default: every screen plays it when nothing is scheduled.
      Change it later with Play on every screen on another playlist.
    </p>
  );
}

/** For a takeover or a narrower entry: which playlist to make the default first, or none. */
export function FirstDefaultChoice({
  playlists,
  value,
  onChange,
  action,
}: {
  playlists: PlaylistView[];
  value: string;
  onChange: (playlistId: string) => void;
  action: string;
}) {
  const id = useId();
  if (playlists.some((p) => p.isDefault)) return null;
  return (
    <div className={`grid gap-1.5 ${BOX}`}>
      <label htmlFor={id} className="font-medium">
        Default playlist
      </label>
      <p id={`${id}-help`}>
        This organization has no default playlist yet: every screen plays it when nothing is scheduled, and until there is one, screens this does not cover get
        nothing. {action} makes the one chosen here the default first.
      </p>
      <NativeSelect id={id} aria-describedby={`${id}-help`} value={value} onChange={(e) => onChange(e.target.value)} className="bg-background">
        <option value="">No default for now</option>
        {playlists.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}
