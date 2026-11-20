/**
 * The week view (M3-19): what one screen plays each hour of this week, in its time zone, as
 * drafted (`weekOf`, which asks player-core's `resolvePlaylist`, as the screen does). Hours run
 * down, days across; a playlist's name shows where it starts and is read for every hour.
 */
import { useId } from 'react';
import { NativeSelect } from '~/components/ui/select';
import type { PlaylistView } from '~/lib/playlists';
import { weekOf, type ScheduleEntryView } from '~/lib/schedule';
import type { GroupView, ScreenView } from '~/lib/screen-types';
import { cn } from '~/lib/utils';
import { useAppStore } from '~/state/provider';

/** The chart tokens, the default playlist on the neutral one. */
const COLOURS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-5)'];
const HOURS = Array.from({ length: 24 }, (_, h) => h);

export function WeekView({
  screens,
  groups,
  entries,
  playlists,
  defaultPlaylistId,
  now,
}: {
  screens: ScreenView[];
  groups: GroupView[];
  entries: ScheduleEntryView[];
  playlists: PlaylistView[];
  defaultPlaylistId: string;
  now: number;
}) {
  const chosen = useAppStore((s) => s.schedule.weekScreenId);
  const choose = useAppStore((s) => s.chooseWeekScreen);
  const id = useId();
  const screen = screens.find((s) => s.id === chosen) ?? screens[0];
  if (!screen) return <p className="text-sm text-muted-foreground">Pair a screen to see its week.</p>;

  const week = weekOf({ screen, groups, entries, defaultPlaylistId, at: new Date(now) });
  const names = new Map(playlists.map((p) => [p.id, p.name]));
  const shown = [...new Set(week.flatMap((d) => d.hours.flatMap((h) => (h ? [h.playlistId] : []))))];
  const colour = new Map(shown.map((p, i) => [p, p === defaultPlaylistId ? 'var(--chart-4)' : COLOURS[i % COLOURS.length]!]));
  const dayName = (date: string) =>
    new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <label htmlFor={`${id}-screen`} className="text-sm font-medium">
            Screen
          </label>
          <NativeSelect id={`${id}-screen`} value={screen.id} onChange={(e) => choose(e.target.value)} className="w-64">
            {screens.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <p className="pb-2 text-sm text-muted-foreground">Times in {screen.timezone.replaceAll('_', ' ')}, as drafted.</p>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Playlists this week">
        {shown.map((p) => (
          <li key={p} className="flex items-center gap-1.5">
            <span className="size-3 rounded-sm" style={{ background: colour.get(p) }} aria-hidden />
            {names.get(p) ?? p}
            {p === defaultPlaylistId && <span className="text-muted-foreground">(default)</span>}
          </li>
        ))}
      </ul>
      <section
        aria-label={`Week of ${screen.name}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: it scrolls at phone width and holds nothing focusable, so it takes focus itself, else a keyboard cannot scroll it (WCAG 2.1.1).
        tabIndex={0}
        className="overflow-x-auto rounded-xl border bg-card outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <table className="w-full min-w-[42rem] table-fixed border-collapse text-xs">
          <caption className="sr-only">
            What {screen.name} plays each hour this week, in {screen.timezone}
          </caption>
          <thead>
            <tr>
              <th scope="col" className="w-14 border-b p-1.5 text-left font-medium text-muted-foreground">
                <span className="sr-only">Hour</span>
              </th>
              {week.map((d) => (
                <th key={d.date} scope="col" className="border-b p-1.5 text-left font-medium">
                  {dayName(d.date)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {HOURS.map((hour) => (
              <tr key={hour}>
                <th scope="row" className="p-1.5 text-left font-mono font-normal text-muted-foreground">
                  {String(hour).padStart(2, '0')}:00
                </th>
                {week.map((d) => {
                  const cell = d.hours[hour];
                  if (!cell)
                    return (
                      <td key={d.date} className="p-1.5 text-muted-foreground">
                        Skipped
                      </td>
                    );
                  const above = hour > 0 ? d.hours[hour - 1] : null;
                  const continues = above?.playlistId === cell.playlistId && above.takeover === cell.takeover;
                  const current = now >= cell.at.getTime() && now < cell.at.getTime() + 3_600_000;
                  return (
                    <td key={d.date} aria-current={current ? 'time' : undefined} className={cn('p-0', current && 'outline-2 outline-ring')}>
                      <div className="flex h-7 items-center gap-1.5 border-l-4 px-1.5" style={{ borderColor: colour.get(cell.playlistId) }}>
                        <span className={cn('truncate', continues && 'sr-only', cell.takeover && 'font-semibold')}>
                          {cell.takeover && 'Takeover: '}
                          {names.get(cell.playlistId) ?? cell.playlistId}
                        </span>
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
