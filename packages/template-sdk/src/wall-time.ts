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
  const clock = clockIn(ctx.timezone);
  /** How far the zone's clock is ahead of UTC at instant `t`. */
  const offset = (t: number) => {
    const p = Object.fromEntries(clock.formatToParts(t).map((x) => [x.type, Number(x.value)]));
    // setUTCFullYear, not Date.UTC: that reads years 0 to 99 as 1900 to 1999.
    const read = new Date(0);
    read.setUTCFullYear(p.year!, p.month! - 1, p.day);
    read.setUTCHours(p.hour!, p.minute, p.second);
    return read.getTime() - t;
  };
  // A zone changes its offset at most once within a day either side, so the wall time is read with one of these two.
  const before = offset(local - 86_400_000);
  const after = offset(local + 86_400_000);
  const fits = [local - before, local - after].filter((t) => t + offset(t) === local);
  return new Date(fits.length ? Math.min(...fits) : local - before);
}

/** One clock per zone: a template reading a list of dates builds one, not one a row, on the Pi. */
const clocks = new Map<string, Intl.DateTimeFormat>();

/** The zone's clock, read in parts: what its wall shows at an instant. */
function clockIn(timeZone: string): Intl.DateTimeFormat {
  let clock = clocks.get(timeZone);
  if (!clock) {
    clock = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    clocks.set(timeZone, clock);
  }
  return clock;
}
