/**
 * Display hours (`DisplayHours` in the contract): weekly windows, and dated exceptions that
 * replace a day's windows (closed, or other hours). Checked as the player checks them, with the
 * contract's `displayHoursProblems`, so the CMS refuses what a screen would.
 */
import { displayHoursProblems } from '@signforge/contract';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useId } from 'react';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import type { DisplayHours } from '~/lib/screen-types';
import { cn } from '~/lib/utils';

/** Monday first, as people read a week; the contract counts 0 as Sunday. */
const DAYS: [number, string, string][] = [
  [1, 'Mon', 'Monday'],
  [2, 'Tue', 'Tuesday'],
  [3, 'Wed', 'Wednesday'],
  [4, 'Thu', 'Thursday'],
  [5, 'Fri', 'Friday'],
  [6, 'Sat', 'Saturday'],
  [0, 'Sun', 'Sunday'],
];

export const DEFAULT_HOURS: DisplayHours = { weekly: [{ days: [1, 2, 3, 4, 5, 6, 0], from: '07:00', to: '22:00' }] };

export function hoursProblems(hours: DisplayHours | null): string[] {
  if (!hours) return [];
  const problems = displayHoursProblems(hours);
  if (hours.weekly.some((w) => w.days.length === 0)) problems.push('every window needs at least one day');
  return problems;
}

/** "Mon–Fri 07:00–19:00 · Sat 09:00–17:00", or "Always on". */
export function describeHours(hours: DisplayHours | null): string {
  if (!hours) return 'Always on';
  if (!hours.weekly.length) return 'Off, except on dated exceptions';
  return hours.weekly.map((w) => `${dayRange(w.days)} ${w.from}–${w.to}`).join(' · ');
}

function dayRange(days: number[]): string {
  const order = DAYS.map(([d]) => d).filter((d) => days.includes(d));
  if (order.length === 7) return 'Every day';
  const names = DAYS.filter(([d]) => days.includes(d)).map(([, short]) => short);
  const idx = order.map((d) => DAYS.findIndex(([x]) => x === d));
  const consecutive = idx.every((v, i) => i === 0 || v === idx[i - 1]! + 1);
  return consecutive && names.length > 2 ? `${names[0]}–${names.at(-1)}` : names.join(', ');
}

export function DisplayHoursEditor({ value, onChange }: { value: DisplayHours | null; onChange: (v: DisplayHours | null) => void }) {
  const id = useId();
  const problems = hoursProblems(value);
  const setWeekly = (weekly: DisplayHours['weekly']) => onChange({ ...value!, weekly });
  const setExceptions = (exceptions: NonNullable<DisplayHours['exceptions']>) =>
    onChange({ ...value!, exceptions: exceptions.length ? exceptions : undefined });

  return (
    <fieldset className="space-y-4">
      <legend className="text-sm font-medium">Display hours</legend>
      <div className="flex flex-wrap gap-2">
        {(
          [
            ['always', 'Always on', null],
            ['hours', 'Set hours', value ?? DEFAULT_HOURS],
          ] as const
        ).map(([key, label, next]) => {
          const checked = key === 'always' ? !value : !!value;
          return (
            <label
              key={key}
              className={cn(
                'flex h-9 cursor-pointer items-center rounded-full border px-3.5 text-sm has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50',
                checked ? 'border-foreground bg-foreground text-background' : 'border-border-strong bg-card hover:bg-accent',
              )}
            >
              <input type="radio" name={`${id}-mode`} className="sr-only" checked={checked} onChange={() => onChange(next)} />
              {label}
            </label>
          );
        })}
      </div>

      {value && (
        <>
          <ul className="space-y-3">
            {value.weekly.map((w, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a window has no id; its place in the list is what it is.
              <li key={i} className="space-y-2 rounded-lg border p-3">
                <fieldset className="flex flex-wrap gap-1">
                  <legend className="sr-only">Days for window {i + 1}</legend>
                  {DAYS.map(([d, short, long]) => {
                    const on = w.days.includes(d);
                    return (
                      <button
                        key={d}
                        type="button"
                        aria-pressed={on}
                        aria-label={long}
                        onClick={() =>
                          setWeekly(value.weekly.map((x, j) => (j === i ? { ...x, days: on ? x.days.filter((y) => y !== d) : [...x.days, d].sort() } : x)))
                        }
                        className={cn(
                          'h-8 min-w-11 rounded-md border px-2 text-xs font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                          on ? 'border-primary bg-primary text-primary-foreground' : 'border-border-strong bg-card text-foreground hover:bg-accent',
                        )}
                      >
                        {short}
                      </button>
                    );
                  })}
                </fieldset>
                <div className="flex flex-wrap items-end gap-2">
                  <TimeField label="On at" value={w.from} onChange={(from) => setWeekly(value.weekly.map((x, j) => (j === i ? { ...x, from } : x)))} />
                  <TimeField label="Off at" value={w.to} onChange={(to) => setWeekly(value.weekly.map((x, j) => (j === i ? { ...x, to } : x)))} />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove window ${i + 1}`}
                    onClick={() => setWeekly(value.weekly.filter((_, j) => j !== i))}
                  >
                    <Trash2Icon aria-hidden />
                  </Button>
                </div>
                {w.to <= w.from && <p className="text-xs text-muted-foreground">Ends after midnight, the next day.</p>}
              </li>
            ))}
          </ul>
          <Button type="button" variant="outline" size="sm" onClick={() => setWeekly([...value.weekly, { days: [6, 0], from: '09:00', to: '17:00' }])}>
            <PlusIcon aria-hidden /> Add hours
          </Button>

          <div className="space-y-2">
            <h3 className="text-sm font-medium" id={`${id}-ex`}>
              Dates with other hours
            </h3>
            <p className="text-xs text-muted-foreground">A holiday or an event: the date's hours replace the weekly ones.</p>
            <ul aria-labelledby={`${id}-ex`} className="space-y-2">
              {(value.exceptions ?? []).map((e, i) => {
                const all = value.exceptions ?? [];
                const set = (next: (typeof all)[number]) => setExceptions(all.map((x, j) => (j === i ? next : x)));
                const closed = e.on.length === 0;
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a dated exception is edited in place, date included.
                  <li key={i} className="flex flex-wrap items-end gap-2 rounded-lg border p-3">
                    <div className="grid gap-1 text-xs font-medium">
                      <label htmlFor={`${id}-date-${i}`}>Date</label>
                      <Input id={`${id}-date-${i}`} type="date" value={e.date} onChange={(ev) => set({ ...e, date: ev.target.value })} className="w-40" />
                    </div>
                    <label className="flex h-10 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={closed}
                        onChange={(ev) => set({ ...e, on: ev.target.checked ? [] : [{ from: '09:00', to: '17:00' }] })}
                        className="size-4 accent-primary"
                      />
                      Off all day
                    </label>
                    {!closed && (
                      <>
                        <TimeField label="On at" value={e.on[0]!.from} onChange={(from) => set({ ...e, on: [{ ...e.on[0]!, from }] })} />
                        <TimeField label="Off at" value={e.on[0]!.to} onChange={(to) => set({ ...e, on: [{ ...e.on[0]!, to }] })} />
                      </>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${e.date || 'this date'}`}
                      onClick={() => setExceptions(all.filter((_, j) => j !== i))}
                    >
                      <Trash2Icon aria-hidden />
                    </Button>
                  </li>
                );
              })}
            </ul>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setExceptions([...(value.exceptions ?? []), { date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), on: [] }])}
            >
              <PlusIcon aria-hidden /> Add a date
            </Button>
          </div>
        </>
      )}
      <ul role="alert" className="space-y-1 text-sm font-medium text-destructive empty:hidden">
        {problems.map((p) => (
          <li key={p}>{p[0]!.toUpperCase() + p.slice(1)}.</li>
        ))}
      </ul>
    </fieldset>
  );
}

function TimeField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div className="grid gap-1 text-xs font-medium">
      <label htmlFor={id}>{label}</label>
      <Input
        id={id}
        type="time"
        step={60}
        value={value === '24:00' ? '00:00' : value}
        onChange={(e) => onChange(e.target.value)}
        className="w-32 font-mono"
        required
      />
    </div>
  );
}

/** The week as seven bars, the awake windows filled. Text beside says the same. */
export function WeekBars({ hours }: { hours: DisplayHours | null }) {
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  return (
    <div role="img" aria-label={describeHours(hours)} className="grid grid-cols-[2.5rem_1fr] items-center gap-x-2 gap-y-1.5 text-xs">
      {DAYS.map(([d, short]) => {
        const spans = hours
          ? hours.weekly
              .filter((w) => w.days.includes(d))
              .flatMap((w) => {
                const [a, b] = [toMin(w.from), toMin(w.to)];
                return b > a
                  ? [[a, b]]
                  : [
                      [a, 1440],
                      [0, b],
                    ];
              })
          : [[0, 1440]];
        return (
          <div key={d} className="contents">
            <span className="text-muted-foreground">{short}</span>
            <span className="relative h-2 overflow-hidden rounded-sm bg-muted">
              {spans.map(([a, b]) => (
                <span
                  key={`${a}-${b}`}
                  className="absolute inset-y-0 bg-chart-1"
                  style={{ left: `${(a! / 1440) * 100}%`, width: `${((b! - a!) / 1440) * 100}%` }}
                />
              ))}
            </span>
          </div>
        );
      })}
    </div>
  );
}
