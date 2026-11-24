/**
 * Before a publish from the Schedule's dialogs, when the org has no default playlist (#243): without
 * one no screen can be published to. When it has one never published (#393), the dialog says so and
 * publishes it too only if the person ticks that: nothing goes live they were not shown. An entry on every screen at all hours makes its playlist the
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

/** When the default playlist was never published: say so, and publish it with this only if ticked (#393). */
export function UnpublishedDefault({ playlists, checked, onChange }: { playlists: PlaylistView[]; checked: boolean; onChange: (checked: boolean) => void }) {
  const current = playlists.find((p) => p.isDefault);
  if (!current || current.published) return null;
  return (
    <div className={`grid gap-1.5 ${BOX}`}>
      <p>
        <bdi>{current.name}</bdi> is the default playlist but is not published yet: screens get nothing when nothing is scheduled until it is.
      </p>
      <label className="flex items-center gap-2 font-medium">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-primary" />
        Publish <bdi>{current.name}</bdi> too, with its unpublished spots
      </label>
    </div>
  );
}
