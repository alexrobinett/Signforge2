/** Wall-clock fields in some zone. Months are 1-based, as in iCalendar. */
export interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const zoneCache = new Map<string, Intl.DateTimeFormat | null>();

/** A formatter for an IANA zone, or null when the runtime does not know the name. */
function zoneFormat(tz: string): Intl.DateTimeFormat | null {
  let f = zoneCache.get(tz);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch {
      f = null;
    }
    zoneCache.set(tz, f);
  }
  return f;
}

export const isIanaZone = (tz: string): boolean => zoneFormat(tz) !== null;

const wallMs = (w: Wall) => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);

/** Offset of `tz` from UTC at instant `ms`, in milliseconds. */
function offsetAt(ms: number, f: Intl.DateTimeFormat): number {
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(ms)) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(ms / 1000) * 1000;
}

/** The instant a wall-clock time in an IANA zone names. Assumes `tz` passed `isIanaZone`. */
export function wallToInstant(w: Wall, tz: string): number {
  const f = zoneFormat(tz)!;
  const guess = wallMs(w);
  const first = guess - offsetAt(guess, f);
  const second = guess - offsetAt(first, f);
  return second;
}

const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, '0');

export const isoDate = (w: Pick<Wall, 'year' | 'month' | 'day'>) => `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;

/**
 * An ISO 8601 instant written in the event's own offset, as datad.py wrote it:
 * `2026-11-18T10:00:00-05:00`, and `+00:00` for UTC.
 */
export function isoInstant(ms: number, offsetMs: number): string {
  const d = new Date(ms + offsetMs);
  const off = Math.round(offsetMs / 60_000);
  const sign = off < 0 ? '-' : '+';
  return (
    `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  );
}

export const wallOffset = (w: Wall, ms: number) => wallMs(w) - ms;
