# @signforge/feeds

Turns a data source's feed body into the contract's shapes. Pure functions: no fetching (that is the poller, `apps/api/src/data`), and the time is a parameter.

- `parseCalendar(text, { now })`: iCalendar to `CalendarFeed`.
- `parseNews(text)`: RSS 2.0 or Atom to `NewsFeed`, with the feed's `language` (RSS `<language>`, Atom `xml:lang`) (`''` unless it declares a BCP 47 tag).
- `normaliseFeed(format, text, options)`: either, by the data source's `ical` or `rss` format.

Failures throw `FeedError` with a `code` (`too-large`, `doctype`, `malformed`, `unknown-format`) for the poller to report without echoing the body.

## Calendars

- Events that have ended by `now`, and events starting 30 days or more after it, are left out. The rest are sorted soonest first and capped at 25.
- Recurring events (RRULE, RDATE) are expanded with ical.js, honouring EXDATE and RECURRENCE-ID: a cancelled instance is dropped, a moved one appears at its new time, including one moved into the window from beyond it. ical.js steps a series from its first occurrence, so a series is started near `now` instead: its first occurrence moved on by whole periods of wall-clock days (daily and weekly rules, and sub-daily ones, without COUNT), which keeps every occurrence in step across DST. The 500-occurrence cap counts from `now`; what is left of the past (all of it for COUNT, monthly and yearly rules) is stepped through on a budget of 5,000. A series with more past occurrences than that shows nothing.
- `STATUS:CANCELLED` drops an event, a series or one instance.
- Times: a TZID that names an IANA zone is used directly; otherwise the file's VTIMEZONE for it (Outlook's Windows names); otherwise X-WR-TIMEZONE; otherwise UTC. Floating times use X-WR-TIMEZONE, then UTC. Timed events are written in their own offset (`2026-11-18T10:00:00-05:00`); all-day events as dates, with an exclusive end.
- An all-day event stays until its end date has begun everywhere (UTC-12), because the feed does not know the screen's zone; the template trims it to the screen's day.
- No DTEND or DURATION: a day for an all-day event, an hour for a timed one.

## News

- XML that declares a DOCTYPE, or contains `<!ENTITY` anywhere, is refused before parsing.
- Item dates become UTC instants (`2026-11-17T12:20:57+00:00`); a date that does not parse is kept as written and sorted last. Items are newest first, untitled ones dropped, capped at 20.
- Atom entries use `updated`, then `published`.

## Limits

`LIMITS` holds the defaults (1 MB body, 500 iterations from now and 5,000 before it, 25 events, 20 items, 30 days); each can be overridden per call.

## Tests

`pnpm test` runs inside workerd through `@cloudflare/vitest-plugin`, against fixtures in `test/fixtures`: Google and Outlook exports and a weekly meeting with a cancelled and a moved instance (written for these tests), the public US holidays calendar and an NPR RSS feed (downloaded 2026-11-17), and an Atom feed.
