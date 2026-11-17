/**
 * Expands an iCal feed's recurring events over a window with ical.js, inside workerd: RRULE,
 * EXDATE, and moved instances (RECURRENCE-ID). The limits are the plan's: 1 MB body, 500
 * iterations per event, 25 events out.
 */
import ICAL from 'ical.js';

export interface Occurrence { uid: string; summary: string; start: string; end: string }

export function expandCalendar(body: string, from: Date, days = 30, maxIterations = 500, maxOut = 25): Occurrence[] {
  if (body.length > 1_000_000) throw new Error('feed over 1 MB');
  const comp = new ICAL.Component(ICAL.parse(body));
  const vevents = comp.getAllSubcomponents('vevent');
  const until = ICAL.Time.fromJSDate(new Date(from.getTime() + days * 86_400_000), true);
  const start = ICAL.Time.fromJSDate(from, true);
  // Masters first, then attach their moved instances.
  const masters = new Map<string, InstanceType<typeof ICAL.Event>>();
  const exceptions: InstanceType<typeof ICAL.Event>[] = [];
  for (const v of vevents) {
    const ev = new ICAL.Event(v);
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else masters.set(ev.uid, ev);
  }
  for (const ex of exceptions) masters.get(ex.uid)?.relateException(ex);
  const out: Occurrence[] = [];
  for (const ev of masters.values()) {
    if (!ev.isRecurring()) {
      if (ev.endDate.compare(start) > 0 && ev.startDate.compare(until) < 0)
        out.push({ uid: ev.uid, summary: ev.summary, start: ev.startDate.toJSDate().toISOString(), end: ev.endDate.toJSDate().toISOString() });
      continue;
    }
    const it = ev.iterator();
    for (let i = 0, next = it.next(); next && i < maxIterations; i++, next = it.next()) {
      if (next.compare(until) >= 0) break;
      const d = ev.getOccurrenceDetails(next);
      if (d.endDate.compare(start) <= 0) continue;
      out.push({ uid: ev.uid, summary: d.item.summary, start: d.startDate.toJSDate().toISOString(), end: d.endDate.toJSDate().toISOString() });
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start)).slice(0, maxOut);
}

/** Weekly standup at 09:00 New York, 3 Dec cancelled, 10 Dec moved to 14:00. */
export const SAMPLE_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//sf-spike//EN
BEGIN:VTIMEZONE
TZID:America/New_York
BEGIN:STANDARD
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
UID:standup@sf
DTSTART;TZID=America/New_York:20261105T090000
DTEND;TZID=America/New_York:20261105T093000
RRULE:FREQ=WEEKLY;BYDAY=TH
EXDATE;TZID=America/New_York:20261203T090000
SUMMARY:Standup
END:VEVENT
BEGIN:VEVENT
UID:standup@sf
RECURRENCE-ID;TZID=America/New_York:20261210T090000
DTSTART;TZID=America/New_York:20261210T140000
DTEND;TZID=America/New_York:20261210T143000
SUMMARY:Standup (moved)
END:VEVENT
END:VCALENDAR
`;
