# @signforge/feeds

Turns a data source's feed body into the contract's shapes. Pure functions: no fetching (that is the poller, `apps/api/src/data`), and the time is a parameter.

- `parseCalendar(text, { now })`: iCalendar to `CalendarFeed`.
- `parseNews(text, { url })`: RSS 2.0 or Atom to `NewsFeed`, with the feed's `language` (RSS `<language>`, Atom `xml:lang`) (`''` unless it declares a BCP 47 tag), plus each story's `image` and the feed's `logo` (below). `url` is the feed's own address, for relative links.
- `parseCsv(text)`: a CSV file to `TableFeed`.
- `parseJsonTable(text, { rowsPath })`: a JSON list of objects (the document, or the list at `rowsPath`) to `TableFeed`.
- `normaliseFeed(format, text, options)`: any of them, by the data source's `ical`, `rss`, `csv` or `json-table` format. For `rss` it gives the `NewsFeed` alone, what a snapshot carries: no image is looked for, and none is in it.

Failures throw `FeedError` with a `code` (`too-large`, `doctype`, `malformed`, `unknown-format`, `not-a-table`) for the poller to report without echoing the body.

## Calendars

- Events that have ended by `now`, and events starting 30 days or more after it, are left out. The rest are sorted soonest first and capped at 25.
- Recurring events (RRULE, RDATE) are expanded with ical.js, honouring EXDATE and RECURRENCE-ID: a cancelled instance is dropped, a moved one appears at its new time, including one moved into the window from beyond it. ical.js steps a series from its first occurrence, so a series is started near `now` instead: its first occurrence moved on by whole periods of wall-clock days (daily and weekly rules, and sub-daily ones, without COUNT), which keeps every occurrence in step across DST. The 500-occurrence cap counts from `now`; what is left of the past (all of it for COUNT, monthly and yearly rules) is stepped through on a budget of 5,000. A series with more past occurrences than that shows nothing.
- `STATUS:CANCELLED` drops an event, a series or one instance.
- Times: a TZID that names an IANA zone is used directly; otherwise the file's VTIMEZONE for it (Outlook's Windows names); otherwise X-WR-TIMEZONE; otherwise UTC. Floating times use X-WR-TIMEZONE, then UTC. Timed events are written in their own offset (`2026-11-18T10:00:00-05:00`); all-day events as dates, with an exclusive end.
- An all-day event stays until its end date has begun everywhere (UTC-12), because the feed does not know the screen's zone; the template trims it to the screen's day.
- No DTEND or DURATION: a day for an all-day event, an hour for a timed one.

## News

- XML that declares a DOCTYPE, or contains `<!ENTITY` anywhere, is refused before parsing. The prolog is read forward once, each comment and processing instruction skipped whole (a `<!--` or `<a` inside `<?…?>` is neither), and one left open is refused as `malformed`.
- Elements are known by their namespace, not their prefix, so Media RSS, `content:encoded`, `dc:date` and iTunes are found whatever prefix a feed binds. Namespace names are compared without case, a final slash, or the difference between `http:` and `https:`. What is read:
  - RSS 2.0 with no namespace, or under UserLand's `http://backend.userland.com/rss2` as its default.
  - Atom 1.0 (`http://www.w3.org/2005/Atom`), and Atom 0.3 (`http://purl.org/atom/ns#`) as before: its titles, language, links and bodies, but not its `modified` and `issued` dates, so its entries are undated.
  - `dc:date` under Dublin Core's namespace, or under a `dc` prefix the feed never declares (the one prefix read undeclared).
  - Not read: a `feed` in no namespace or another one, RSS under any other default namespace, RSS 1.0 (RDF). Each is `unknown-format`.
- Item dates become UTC instants (`2026-11-17T12:20:57+00:00`); a date that does not parse is kept as written and sorted last. Items are newest first, untitled ones dropped, capped at 20.
- Atom entries use `updated`, then `published`.

### Images

`parseNews` finds each kept story's image (`{ url, width?, height? }`, the size only when the feed gives it) and the feed's logo. Both are third-party URLs, so they stay on the server: a screen never fetches, and `normaliseFeed` leaves them out. Nothing fetches them yet: the poller is to fetch, check and store them (#195), and a snapshot to name each by its hash (#196). Why this order, and what real feeds do: `docs/research/rss-images.md`.

An item's image is the first of these that has one:

1. Media RSS `media:content`, on the item or in a `media:group`: the widest, skipping video and audio (an entry with neither `medium` nor `type` counts as an image, as many feeds write it).
2. Media RSS `media:thumbnail`, on the item, in a group or in a `media:content`: the widest.
3. An RSS `enclosure` with an `image/` type.
4. An Atom `link rel="enclosure"` with an `image/` type.
5. `itunes:image`.
6. The first real `<img>` in the body: RSS `content:encoded`, then `description`; Atom `content`, then `summary`. Skipped: a width or height of 2 px or less; a tracking pixel or spacer, by a whole host label, folder or file name (`pixel.wp.com`, `/pixel/`, `/tracking/`, `spacer.png`; not `google-pixel-10-review.jpg`), or feedburner's; Gravatar avatars and WordPress emoji, by URL or by the class `avatar`, `emoji` or `wp-smiley`; NPR's `src='undefined'`. An `srcset` gives its largest candidate (by `w`, else `x`) of those not skipped, and `src` when none is left.
   - An HTML body is read by a small tokenizer that moves forward only, as a browser reads tags: a quoted attribute value may hold `>` or `<img`, comments and the insides of `script` and `style` are skipped, and a tag, quote or comment left open ends the body. Where it differs from a browser, knowingly: `<![CDATA[…]]>` in HTML is read as content (a browser ends it at the first `>`); `<!-->` runs to the next `-->` (a browser ends it at once); `<textarea>`'s contents are read as tags.
   - Atom `type="xhtml"` content is read from its parsed elements: the first XHTML `img`, depth first. The XML parser groups an element's children by name, so siblings of different names are read name by name.

The logo is the RSS channel's `<image><url>`, or Atom's `logo`, then `icon`.

Every URL resolves against the `xml:base` in scope where it is written (its own element's, then each one above it, a relative one against the next), else the item's link, else the feed's URL. Only `http:` and `https:` URLs are kept, after resolving: `data:`, `file:`, `javascript:` and the rest are dropped, and so is a relative URL with nothing to resolve against. The other checks (https, no private addresses, the size and type of what comes back) are the fetcher's, as for feed URLs.

What it costs: the XML is parsed once, for the text and the images alike. Images are looked for only in the items kept (newest first, `maxItems`), each body is read in one pass, and one parse resolves URLs and visits XHTML elements 2,000 times at most between them (`SEARCH_BUDGET`; a real feed uses a few hundred), shared equally among the kept stories and the logo, so a hostile story loses its own image rather than time or the others' images. A URL or `xml:base` longer than 2,048 characters, before or after resolving, is dropped.

## Tables

- CSV follows RFC 4180 with a header row: commas between cells, double quotes around a cell that holds a comma, a quote (doubled) or a line break; CRLF or LF between records; UTF-8, a byte order mark dropped. Cells stay text as written ("$4.50", "02134"). Blank lines are skipped and short rows padded with empty cells. A column with no name is dropped when all its cells are empty. `malformed`: no header row, a quote never closed or followed by text, two columns with one name, a named-less column with cells, a row with more cells than the header.
- JSON: every key of the objects is a column, in the order first seen; text and numbers stay as they are, `true` and `false` become words, and anything else (null, a nested object or list) is an empty cell. `not-a-table`: the document, or the value at `rowsPath`, is not a list of objects.
- `too-large`, before any row is built: a table with more cells (columns × rows) than half `MAX_SNAPSHOT_BYTES`, which no snapshot can hold. Reading a CSV stops as soon as it has more rows than that. Every step is one pass over the body or over that many cells: a Worker has 30 s of CPU, and a poll run carries other orgs' sources. Padding every row to every column turns a small body into millions of cells (each object with a key of its own, short rows under a wide header).
- How rows fill a template's list field (columns per item property, filter, sort, `maxItems`) is the contract's `tableItems`, run where the data is played.

## Limits

`LIMITS` holds the defaults (1 MB body, 500 iterations from now and 5,000 before it, 25 events, 20 items, 30 days); each can be overridden per call.

## Tests

`pnpm test` runs inside workerd through `@cloudflare/vitest-plugin`, against fixtures in `test/fixtures`: Google and Outlook exports and a weekly meeting with a cancelled and a moved instance (written for these tests), the public US holidays calendar and an NPR RSS feed (downloaded 2026-11-17), and an Atom feed. The image fixtures were written for these tests, after real feeds: Media RSS with a `media:group` and video first, a podcast's enclosures, Atom enclosures with `xml:base` and a logo, Atom `xhtml` content, Atom 0.3, RSS under UserLand's namespace with Media RSS under https, `dc:date` under an https or undeclared namespace, a WordPress body (a pixel, emoji, an avatar, a relative `src`, an `srcset`), and hostile URLs. Tests that bound a parse's cost compare it with a linear pass measured in the same run (`test/linear.ts`), never with a fixed time, check what the parse found, and set a timeout from a CI run.
