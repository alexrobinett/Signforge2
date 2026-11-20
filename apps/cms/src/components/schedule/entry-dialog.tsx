/**
 * Making or changing a schedule entry (M3-19): a playlist, whom it plays on (every screen, a group,
 * one screen), and when (weekdays, a daily window, dates), with a priority for where entries
 * overlap. Saved as a draft; the page's Publish sends it.
 */
import { LoaderCircleIcon } from 'lucide-react';
import { useId, type SubmitEvent } from 'react';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { NativeSelect } from '~/components/ui/select';
import { DAYS } from '~/lib/days';
import type { PlaylistView } from '~/lib/playlists';
import type { GroupView, ScreenView } from '~/lib/screen-types';
import { cn } from '~/lib/utils';
import { useAppStore } from '~/state/provider';
import { entryProblems } from '~/state/schedule';
import { TargetFields } from './target-fields';

export function EntryDialog({ orgId, playlists, screens, groups }: { orgId: string; playlists: PlaylistView[]; screens: ScreenView[]; groups: GroupView[] }) {
  const d = useAppStore((s) => s.schedule.entry);
  const saving = useAppStore((s) => s.schedule.saving);
  const error = useAppStore((s) => s.schedule.error);
  const edit = useAppStore((s) => s.editEntry);
  const save = useAppStore((s) => s.saveEntry);
  const close = useAppStore((s) => s.closeScheduleDialog);
  const id = useId();
  if (!d) return null;
  const problems = entryProblems(d);

  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!problems.length) void save(orgId);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{d.id ? 'Change schedule entry' : 'Schedule a playlist'}</DialogTitle>
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
          <TargetFields value={d} screens={screens} groups={groups} onChange={edit} />
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
            <div role="alert" className="text-sm text-destructive">
              {error ?? problems[0]}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || problems.length > 0}>
              {saving && <LoaderCircleIcon className="animate-spin" aria-hidden />} Save draft
            </Button>
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
