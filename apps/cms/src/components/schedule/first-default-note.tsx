/**
 * Before a publish from the Schedule's dialogs, when the org has no default playlist (#243): without
 * one no screen can be published to. When it has one never published (#393), the dialog says so and
 * publishes it too only if the person ticks that: nothing goes live they were not shown. An entry on every screen at all hours makes its playlist the
 * default as it publishes (the `publish` tool's `madeDefault`), and the dialog says so. For a takeover
 * or a narrower entry (owner decision) the dialog says, once, that its playlist also becomes the
 * default, with Change for another or none (#371): Save and publish, or Take over, makes it the
 * default first (`set_default_playlist`).
 */
import { useId } from 'react';
import { NativeSelect } from '~/components/ui/select';
import type { PlaylistView } from '~/lib/playlists';

const BOX = 'min-w-0 rounded-md border border-status-updating bg-status-updating-muted px-3 py-2 text-sm text-status-updating-foreground wrap-anywhere';

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

/** Given focus as it is drawn: the choice Change opened (#371). Defined once, so React calls it on mount only. */
const focusOnMount = (el: HTMLSelectElement | null) => el?.focus();

/**
 * For a takeover or a narrower entry: the entry's playlist also becomes the default, said once (#371);
 * Change opens the choice of another, or none. `changing`: the person pressed Change (the draft's
 * `firstDefault` is set); until then the default follows the entry's playlist.
 */
export function FirstDefaultChoice({
  playlists,
  value,
  changing,
  onChange,
  action,
}: {
  playlists: PlaylistView[];
  value: string;
  changing: boolean;
  onChange: (playlistId: string) => void;
  action: string;
}) {
  const id = useId();
  if (playlists.some((p) => p.isDefault)) return null;
  const chosen = playlists.find((p) => p.id === value);
  if (chosen && !changing) {
    return (
      <p className={BOX}>
        <bdi className="font-medium">{chosen.name}</bdi> also becomes the default playlist: every screen plays it when nothing is scheduled.{' '}
        <button type="button" onClick={() => onChange(value)} className="font-medium underline underline-offset-4">
          Change<span className="sr-only"> the default playlist</span>
        </button>
      </p>
    );
  }
  return (
    <div className={`grid gap-1.5 ${BOX}`}>
      <label htmlFor={id} className="font-medium">
        Default playlist
      </label>
      <p id={`${id}-help`}>
        This organization has no default playlist yet: every screen plays it when nothing is scheduled, and until there is one, screens this does not cover get
        nothing. {action} makes the one chosen here the default first.
      </p>
      <NativeSelect
        id={id}
        ref={changing ? focusOnMount : undefined}
        aria-describedby={`${id}-help`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-background"
      >
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
