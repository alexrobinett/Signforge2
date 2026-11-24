/**
 * Taking over screens (M3-19): a playlist on every screen, a group or one screen, from now until a
 * time at most a day away, above every schedule entry. Sent at once: screens end the spot on
 * screen and play it, and drop it on time, offline too.
 */
import { LoaderCircleIcon } from 'lucide-react';
import { useId, type SubmitEvent } from 'react';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { NativeSelect } from '~/components/ui/select';
import type { PlaylistView } from '~/lib/playlists';
import type { GroupView, ScreenView } from '~/lib/screen-types';
import { useAppStore } from '~/state/provider';
import { DIALOG, firstDefaultOf } from '~/state/schedule';
import { FirstDefaultChoice, UnpublishedDefault } from './first-default-note';
import { TargetPicker } from './target-picker';

const DAY_MS = 86_400_000;

/** Why the takeover cannot be started yet, or undefined. */
function takeoverProblem(d: { playlistId: string; target: string; groupId: string; screenId: string; until: string }, now: number): string | undefined {
  if (!d.playlistId) return 'Choose a playlist.';
  if (d.target === 'group' && !d.groupId) return 'Choose a group.';
  if (d.target === 'screen' && !d.screenId) return 'Choose a screen.';
  const until = Date.parse(d.until);
  if (Number.isNaN(until) || until <= now) return 'Choose when it ends, after now.';
  if (until - now > DAY_MS) return 'A takeover lasts at most 24 hours: schedule a playlist for longer.';
  return undefined;
}

export function TakeoverDialog({
  orgId,
  playlists,
  screens,
  groups,
  now,
  onCloseAutoFocus,
}: {
  orgId: string;
  playlists: PlaylistView[];
  screens: ScreenView[];
  groups: GroupView[];
  /** The page's clock: a render may not read the time itself. */
  now: number;
  /** Where focus goes when it closes (ScheduleDialogs: what opened it). */
  onCloseAutoFocus: (e: Event) => void;
}) {
  const draft = useAppStore((s) => s.schedule.takeovers[DIALOG]);
  const edit = useAppStore((s) => s.editTakeover);
  const start = useAppStore((s) => s.startTakeover);
  const close = useAppStore((s) => s.closeScheduleDialog);
  const id = useId();
  // A dialog opened in another org is not this page's.
  if (draft?.orgId !== orgId) return null;
  const { edit: d, pending: saving, error } = draft;
  const problem = takeoverProblem(d, now);

  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!problem) void start(orgId);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-xl" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Take over screens</DialogTitle>
          <DialogDescription>
            Sent now: the screens stop what is on screen, play this above any schedule, and go back on their own when it ends, even offline.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-1.5">
            <label htmlFor={`${id}-playlist`} className="text-sm font-medium">
              Playlist
            </label>
            <NativeSelect id={`${id}-playlist`} value={d.playlistId} onChange={(e) => edit({ playlistId: e.target.value })}>
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
          <TargetPicker label="Plays on" value={d} screens={screens} groups={groups} onPick={edit} />
          <div className="grid gap-1.5">
            <label htmlFor={`${id}-until`} className="text-sm font-medium">
              Until
            </label>
            <Input id={`${id}-until`} type="datetime-local" value={d.until} onChange={(e) => edit({ until: e.target.value })} className="w-60 font-mono" />
            <p className="text-xs text-muted-foreground">In your time zone. At most 24 hours from now.</p>
          </div>
          <FirstDefaultChoice playlists={playlists} value={firstDefaultOf(d)} onChange={(firstDefault) => edit({ firstDefault })} action="Taking over" />
          <UnpublishedDefault playlists={playlists} checked={d.publishDefault === true} onChange={(publishDefault) => edit({ publishDefault })} />
          {(error || problem) && (
            <div role="alert" className="text-sm text-destructive">
              {problem ?? error}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !!problem}>
              {saving && <LoaderCircleIcon className="animate-spin" aria-hidden />} Take over now
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
