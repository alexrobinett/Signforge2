import { NativeSelect } from '~/components/ui/select';
import type { PlaylistView } from '~/lib/playlists';

/** The playlist a schedule entry or a takeover plays: the schedule dialog's and the takeover dialog's first field. */
export function PlaylistField({
  id,
  value,
  playlists,
  onPick,
}: {
  id: string;
  value: string;
  playlists: PlaylistView[];
  onPick: (playlistId: string) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        Playlist
      </label>
      <NativeSelect id={id} value={value} onChange={(e) => onPick(e.target.value)}>
        <option value="" disabled>
          Choose a playlist
        </option>
        {playlists.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}
