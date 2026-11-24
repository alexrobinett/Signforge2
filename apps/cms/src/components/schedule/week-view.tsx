/**
 * The week view (M3-19): what one screen plays through this week, in its time zone, as drafted
 * (`weekOf`, which asks player-core's `resolvePlaylist`, as the screen does). Hours run down, days
 * across; within an hour each playlist fills the minutes it plays. A playlist's name shows where it
 * starts, with the time when that is not on the hour, and is read for every hour.
 */
import type { PlaylistView } from '~/lib/playlists';
import { weekOf, type ScheduleEntryView } from '~/lib/schedule';
import { byName } from '~/lib/targets';
import type { GroupView, ScreenView } from '~/lib/screen-types';
import { cn } from '~/lib/utils';
import { useAppStore } from '~/state/provider';
import { TargetPicker } from './target-picker';

/** The chart tokens, the default playlist on the neutral one; past four, mixes of them. */
const COLOURS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-5)',
  'color-mix(in oklab, var(--chart-1) 50%, var(--chart-3))',
  'color-mix(in oklab, var(--chart-2) 50%, var(--chart-5))',
  'color-mix(in oklab, var(--chart-1) 50%, var(--chart-5))',
  'color-mix(in oklab, var(--chart-2) 50%, var(--chart-3))',
];
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
  const screen = screens.find((s) => s.id === chosen) ?? [...screens].sort(byName)[0];
  if (!screen) return <p className="text-sm text-muted-foreground">Pair a screen to see its week.</p>;

  const week = weekOf({ screen, groups, entries, defaultPlaylistId, at: new Date(now) });
  const names = new Map(playlists.map((p) => [p.id, p.name]));
  const shown = [...new Set(week.flatMap((d) => d.hours.flatMap((h) => h?.segments.map((g) => g.playlistId) ?? [])))];
  const colour = new Map(shown.map((p, i) => [p, p === defaultPlaylistId ? 'var(--chart-4)' : COLOURS[i % COLOURS.length]!]));
  const name = (id: string) => names.get(id) ?? id;
  const hhmm = (hour: number, minute: number) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const dayName = (date: string) =>
    new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <TargetPicker
          label="Screen"
          value={{ target: 'screen', groupId: '', screenId: screen.id }}
          screens={screens}
          groups={groups}
          kinds={['screen']}
          onPick={(aim) => choose(aim.screenId)}
          className="w-64"
        />
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
                <th scope="row" className="p-1.5 text-left font-normal text-muted-foreground tabular-nums">
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
                  // A block starts here unless the hour before ends with the same playlist.
                  const before = hour > 0 ? d.hours[hour - 1]?.segments.at(-1) : undefined;
                  const starts = cell.segments.filter((g, i) => i > 0 || !before || before.playlistId !== g.playlistId || before.takeover !== g.takeover);
                  const label = (g: (typeof cell.segments)[number]) =>
                    `${g.from ? `${hhmm(hour, g.from)} ` : ''}${g.takeover ? 'Takeover: ' : ''}${name(g.playlistId)}`;
                  const into = (now - cell.at.getTime()) / 60_000;
                  const current = into >= 0 && into < 60;
                  return (
                    <td key={d.date} aria-current={current ? 'time' : undefined} className="relative h-8 p-0 align-top">
                      {cell.segments.map((g) => (
                        <div
                          key={g.from}
                          aria-hidden
                          className="absolute inset-x-0 border-l-4"
                          // A tint of the playlist's colour, stronger for a takeover, so the week's blocks read at a glance.
                          style={{
                            top: `${(g.from / 60) * 100}%`,
                            height: `${((g.to - g.from) / 60) * 100}%`,
                            borderColor: colour.get(g.playlistId),
                            background: `color-mix(in oklab, ${colour.get(g.playlistId)} ${g.takeover ? 30 : 14}%, transparent)`,
                          }}
                        />
                      ))}
                      {current && (
                        <div aria-hidden className="absolute inset-x-0 h-0.5 bg-foreground" style={{ top: `${(into / 60) * 100}%` }}>
                          <span className="absolute -top-2 right-0.5 rounded bg-foreground px-1 text-2xs font-semibold leading-4 text-background">Now</span>
                        </div>
                      )}
                      <span className={cn('relative block truncate px-1.5 py-1.5 leading-4', !starts.length && 'sr-only')}>
                        {(starts.length ? starts : cell.segments).map((g, i) => (
                          <span key={g.from} className={cn(g.takeover && 'font-semibold')}>
                            {i > 0 && ' · '}
                            {label(g)}
                          </span>
                        ))}
                        {current && <span className="sr-only"> (now)</span>}
                      </span>
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
