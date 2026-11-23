/**
 * Making or changing a schedule entry (M3-19): a playlist, whom it plays on (every screen, a group,
 * one screen), and when (weekdays, a daily window, dates), with a priority for where entries
 * overlap. Saved as a draft, which the Schedule page's Publish sends; or saved and published alone
 * (#181). Aimed at one screen, it says what that screen will play this week, and how to win where
 * it would lose.
 */
import { LoaderCircleIcon, RotateCwIcon } from 'lucide-react';
import { useId, type SubmitEvent } from 'react';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { NativeSelect } from '~/components/ui/select';
import { DAYS } from '~/lib/days';
import { useCanPublish } from '~/lib/live';
import type { PlaylistView } from '~/lib/playlists';
import { entryPreview, publishedEntries, type ScheduleEntryView } from '~/lib/schedule';
import type { SpotView } from '~/lib/spots';
import type { GroupView, ScreenView } from '~/lib/screen-types';
import { cn } from '~/lib/utils';
import { useAppStore } from '~/state/provider';
import { DIALOG, entryProblems, entryWhen } from '~/state/schedule';
import { TargetPicker } from './target-picker';

export function EntryDialog({
  orgId,
  playlists,
  screens,
  groups,
  entries,
  spots,
  now,
  onCloseAutoFocus,
}: {
  orgId: string;
  playlists: PlaylistView[];
  screens: ScreenView[];
  groups: GroupView[];
  /** The schedule as drafted, for what a screen will play. */
  entries: ScheduleEntryView[];
  /** The org's spots: Save and publish names those it sends. */
  spots: SpotView[];
  /** The page's clock: a render may not read the time itself. */
  now: number;
  /** Where focus goes when it closes (ScheduleDialogs: what opened it). */
  onCloseAutoFocus: (e: Event) => void;
}) {
  const draft = useAppStore((s) => s.schedule.entries[DIALOG]);
  const edit = useAppStore((s) => s.editEntry);
  const save = useAppStore((s) => s.saveEntry);
  const saveAndPublish = useAppStore((s) => s.saveAndPublishEntry);
  const canPublish = useCanPublish();
  const reload = useAppStore((s) => s.reloadEntry);
  const close = useAppStore((s) => s.closeScheduleDialog);
  const id = useId();
  // A dialog opened in another org is not this page's.
  if (draft?.orgId !== orgId) return null;
  const { edit: d, pending: saving, error, stale } = draft;
  const problems = entryProblems(d);
  const screen = d.target === 'screen' ? screens.find((s) => s.id === d.screenId) : undefined;
  const names = new Map(playlists.map((p) => [p.id, p.name]));
  const playlist = playlists.find((p) => p.id === d.playlistId);
  const week = (over: ScheduleEntryView[]) =>
    screen && playlist
      ? entryPreview({
          screen,
          groups,
          entries: over,
          draft: { ...entryWhen(d), playlistId: d.playlistId, replaces: draft.record },
          defaultPlaylistId: playlists.find((p) => p.isDefault)?.id ?? '',
          names: (id) => names.get(id) ?? 'a removed playlist',
          at: new Date(now),
        })
      : null;
  // As drafted, as Save draft and then Publish give it; and, where Save and publish is offered, over
  // what screens have, as that pinned publish gives it: other drafts stay off screens.
  const preview = week(entries);
  const afterPublish = canPublish ? week(publishedEntries(entries)) : null;
  const raise = (afterPublish ?? preview)?.raise;
  // The playlist's spots that go with it when it has never been published.
  const firstSpots = playlist && !playlist.published ? spots.filter((s) => playlist.spotIds.includes(s.id) && !s.published) : [];

  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!problems.length) void save(orgId);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      {/* Scroll padding the height of the stuck footer, so a field focused near the foot scrolls clear of it (#253). */}
      <DialogContent className="max-h-[90dvh] scroll-pb-56 overflow-y-auto sm:max-w-xl" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{draft.record ? 'Change schedule entry' : 'Schedule a playlist'}</DialogTitle>
          <DialogDescription>Days and times are each screen's own, in its time zone. Saved as a draft: Publish sends it.</DialogDescription>
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
          {preview && (
            <section aria-label="What this screen will play" className="grid gap-2 rounded-lg border bg-muted/40 px-3 py-2.5 text-sm">
              <p role="status">
                <span className="font-medium">This week, {screen?.name}:</span> {preview.text}
              </p>
              {afterPublish && afterPublish.text !== preview.text && (
                <p role="status">
                  <span className="font-medium">After Save and publish</span>, as screens have the rest (other drafts stay drafts): {afterPublish.text}
                </p>
              )}
              {raise && (
                <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => edit({ priority: raise.priority })}>
                  Raise priority above {raise.above}
                </Button>
              )}
            </section>
          )}
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">Days</legend>
            <div className="flex flex-wrap gap-1">
              {DAYS.map(([day, short, long]) => {
                const on = d.days.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={on}
                    onClick={() => edit({ days: on ? d.days.filter((x) => x !== day) : [...d.days, day] })}
                    className={cn(
                      'h-10 min-w-11 rounded-md border px-2 text-xs font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                      on ? 'border-primary bg-primary text-primary-foreground' : 'border-border-strong bg-card text-foreground hover:bg-accent',
                    )}
                  >
                    <span aria-hidden>{short}</span>
                    <span className="sr-only">{long}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">Time of day</legend>
            <p className="text-xs text-muted-foreground">Leave both empty for all day. An end at or before the start runs past midnight.</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="From" type="time" value={d.from} onChange={(from) => edit({ from })} />
              <Field label="Until" type="time" value={d.to} onChange={(to) => edit({ to })} />
            </div>
          </fieldset>
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">Dates</legend>
            <p className="text-xs text-muted-foreground">Leave empty to play every week.</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="First date" type="date" value={d.startDate} onChange={(startDate) => edit({ startDate })} />
              <Field label="Last date" type="date" value={d.endDate} onChange={(endDate) => edit({ endDate })} />
            </div>
          </fieldset>
          <div className="grid gap-1.5">
            <label htmlFor={`${id}-priority`} className="text-sm font-medium">
              Priority
            </label>
            <Input
              id={`${id}-priority`}
              type="number"
              min={0}
              max={99}
              step={1}
              value={d.priority}
              onChange={(e) => edit({ priority: Math.max(0, Math.min(99, Math.trunc(Number(e.target.value) || 0))) })}
              className="w-24"
              aria-describedby={`${id}-priority-help`}
            />
            <p id={`${id}-priority-help`} className="text-xs text-muted-foreground">
              Where entries overlap, the higher plays; on a tie, a screen's own entry, then its group's, then every screen's.
            </p>
          </div>
          {(error || problems.length > 0) && (
            <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
              {problems[0] ?? error}
              {stale && (
                <Button type="button" variant="outline" size="sm" onClick={() => void reload(orgId)}>
                  <RotateCwIcon aria-hidden /> Reload
                </Button>
              )}
            </div>
          )}
          {canPublish && playlist && (
            <p className="text-xs text-muted-foreground">
              Save and publish sends{' '}
              {playlist.published
                ? 'this entry alone: other drafts stay drafts.'
                : firstSpots.length
                  ? `${playlist.name}, ${firstSpots.length === 1 ? `its spot ${firstSpots[0]!.name}` : `its ${firstSpots.length} spots never published`} and this entry: none has been published.`
                  : `${playlist.name} and this entry: the playlist has never been published.`}
            </p>
          )}
          {/* Stuck to the dialog's foot (#253): on a phone its fields scroll, and Save would be below them. The negative margins span the dialog's padding. */}
          <DialogFooter className="sticky -bottom-6 -mx-6 -mb-6 border-t bg-popover px-6 pt-4 pb-6">
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant={canPublish ? 'outline' : 'default'} disabled={saving || problems.length > 0}>
              {saving && <LoaderCircleIcon className="animate-spin" aria-hidden />} Save draft
            </Button>
            {canPublish && (
              <Button type="button" disabled={saving || problems.length > 0} onClick={() => void saveAndPublish(orgId)}>
                Save and publish
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, type, value, onChange }: { label: string; type: 'time' | 'date'; value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div className="grid gap-1 text-xs font-medium">
      <label htmlFor={id}>{label}</label>
      <Input
        id={id}
        type={type}
        step={type === 'time' ? 60 : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full font-mono"
      />
    </div>
  );
}
