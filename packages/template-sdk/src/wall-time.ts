// Its own entry point, so the bundles of templates that do not read dates stay byte for byte: any edit to the SDK's index renames symbols in every bundle.
import type { TemplateContext } from './index';

/**
 * The instant a `datetime` field's wall time falls on in the screen's time zone, or a `date`
 * field's day starts on there. Compare it with `now()`: a countdown's milliseconds to go are
 * `wallTime(ctx, target).getTime() - now().getTime()`. A wall time the clocks skip (02:30 the night
 * they go forward) is read with the offset before the jump, so it falls as much later as they
 * jumped (03:30); one they repeat (01:30 the night they go back) is the first. Temporal's default
 * ('compatible') does the same.
 */
export function wallTime(ctx: Pick<TemplateContext, 'timezone'>, value: string): Date {
  // The wall time's fields as if they were UTC, to compare with the zone's clock read the same way.
  const local = Date.parse(`${value.length === 10 ? `${value}T00:00` : value}Z`);
  const clock = new Intl.DateTimeFormat('en-US', {
    timeZone: ctx.timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  /** How far the zone's clock is ahead of UTC at instant `t`. */
  const offset = (t: number) => {
    const p = Object.fromEntries(clock.formatToParts(t).map((x) => [x.type, Number(x.value)]));
    return Date.UTC(p.year!, p.month! - 1, p.day, p.hour, p.minute, p.second) - t;
  };
  // A zone changes its offset at most once within a day either side, so the wall time is read with one of these two.
  const before = offset(local - 86_400_000);
  const after = offset(local + 86_400_000);
  const fits = [local - before, local - after].filter((t) => t + offset(t) === local);
  return new Date(fits.length ? Math.min(...fits) : local - before);
}
