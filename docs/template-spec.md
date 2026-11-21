# SignForge template spec

Version 1. This is what a template author, human or agent, builds against and what a reviewer checks. The types and limits here are defined in code in `packages/contract/src/shapes.ts`; if the two disagree, the code is right.

Working examples are in `templates/`: `cstore-promo` (price promotion), `photo-promo` (full-screen photo), `weather` (live data, canvas-drawn rain and snow, and the sun and moon placed from the feed's sunrise and sunset by `now()`), `clock` (live time), `agenda` (calendar feed, list field), `news` (RSS feed, scrolling crawl) and `menu-board` (a list typed by people or filled from a CSV or JSON link).

## What a template is

A folder with four files:

| File | Purpose |
| --- | --- |
| `template.json` | The manifest: identity, fields, duration range, orientations. |
| `index.html` | Markup. Must reference `style.css` and `main.ts` exactly as the example does. |
| `style.css` | Layout and animation. |
| `main.ts` | Calls `defineTemplate()` from `@signforge/template-sdk`. |

The build (`sf build`) bundles these into one self-contained HTML file with the script, styles and fonts inlined. That single file is what ships to screens.

## Manifest

```json
{
  "id": "cstore-promo",
  "version": "1.1.0",
  "name": "C-Store Promo",
  "fields": {
    "price": { "type": "text", "label": "Price", "default": "4", "maxLength": 5 },
    "imageLeft": { "type": "image", "label": "Left product" }
  },
  "duration": { "defaultMs": 8000, "minMs": 4000, "maxMs": 60000 },
  "orientations": ["landscape", "portrait"],
  "uses": [],
  "background": "#06122b"
}
```

- `id`: lowercase letters, digits and dashes.
- `version`: semver. A published version never changes; any edit is a new version.
- `fields`: what the CMS form shows. Types are `text`, `number`, `boolean`, `color`, `select`, `url`, `date`, `datetime`, `image` and `list`. A `list` is repeating rows (menu items, events, headlines): it declares an `item` with its own scalar fields and an optional `maxItems`. A `number` may set `min`, `max` and `step` (counted from `min`, or from 0); a `text` may set `maxLength`. A `url` holds a web address people type, such as a QR code's: an `https:` URL of well-formed text, at most `MAX_URL_BYTES` (2,048) bytes of UTF-8 so a QR code can always carry it, or `''` for none (the template then leaves the QR code out); it may set `maxLength` too. A template with a `url` field needs manifest schema 5 or later: a player before #191 plays schemas 3 and 4 and refuses such a template, so the server tells it to reload (`canPlay` in apps/api `device/sync.ts`), into a player that plays 4 and 5. A `date` is a calendar day, `YYYY-MM-DD`; a `datetime` is a wall time, `YYYY-MM-DDTHH:mm`, with no zone or offset, which the template reads in the screen's time zone: "Friday 18:00" means 18:00 where each screen is, as a person means it, whichever zone the editor is in (an instant would tie the spot to one zone, and a screen elsewhere would count to another hour). Both may set `min` and `max`, of their own kind, and hold a year from 1900 on (typing "26" into a picker's year gives 0026). The CMS shows the browser's date or date-and-time picker. A new spot starts at `min`; with no default or `min`, it starts empty, as an image field starts with no image: the spot is saved, the editor says the field has no date yet, and a publish holds the spot back, saying so, until one is picked (`draftCheck` in `@signforge/compiler/draft`). A list row's date does the same. A bound date or datetime needs its fallback like any bound field, so it is not saved until it has one. A screen never gets an empty date. A template with either needs manifest schema 6: a player before #192 plays schemas 4 and 5 and refuses it, so the server tells it to reload, into a player that plays 5 and 6. Every non-image field needs a `default` or the spot must supply a value. These limits are enforced, on the template's own defaults and on every spot's data, by the contract's `validateTemplateManifest` and `validateSpotData`.
- `duration`: a spot may run for any length inside `minMs` to `maxMs`.
- `orientations`: `landscape`, `portrait` or both.
- `uses`: list `canvas`, `webgl` or `audio` if the template needs them.
- `background`: the colour shown around the template when it is letterboxed on an orientation it does not support.
- `live` (optional): the fields a data source fills. See [Live data](#live-data).
- `protocol` is added by the build: the frame protocol of the SDK it bundled. A rebuilt template speaks the current protocol (2), so it needs a new version; published bundles keep the protocol they were built with, and the player speaks every protocol in `SUPPORTED_PROTOCOLS` (1 and 2).

## Lifecycle

The player and the template talk only through messages. The SDK handles all of it.

1. The template loads and reports `loaded`.
2. The player sends `init` with the spot's data, its image files, the duration of this play, the orientation, the viewport size, the screen's time zone and locale, and (protocol 2) the screen's clock and, when the screen has a brand kit, its theme.
3. The template's document is hidden from load until this first `init`, and until its frame has its size. A new frame starts at 0x0, and what the browser tiles before the size arrives keeps the smallest tiles: on the Pi a full-screen layer then took about a second to raster. Nothing a template does in `prepare` sees the difference.
4. The SDK fills in the data, waits for fonts and images to decode and for the result to be painted, pauses every animation, and reports `ready`.
5. When the spot goes on screen the player sends `play`. Every animation restarts from zero.
6. The player removes the template when the spot's duration is up. The template is not asked.

A template that has not reported `ready` within 2 seconds is skipped.

**New data for a template on screen** (the editor's preview, protocol 2). The player sends `reset`: the SDK calls `stop`, cancels animations, releases the image URLs, restores the document exactly as it loaded, and reports `loaded` again. The usual `init`, `ready` and `play` follow. An `init` that arrives without a `reset` is handled the same way. So `prepare` always starts from the markup in `index.html`, and a list is never built twice. What this asks of a template:
- Look elements up inside the hooks, not once at the top of `main.ts`: a reset replaces them.
- Clear any state kept outside the DOM (a timer, a module variable) in `stop`.

`packages/player/browser/templates.test.ts` checks every template in `templates/`: new data after the first `init` must leave the same document as a fresh load. A protocol-1 bundle has no `reset`; the player reloads its frame instead. A new template goes into the devDependencies of `packages/cli`, `packages/player`, `apps/api` and `apps/template-check`, whose tests build every template, so CI reruns them when it changes ([`ci.md`](ci.md#what-affected-means)).

## What the SDK gives you

- `data-sf="field"` on an element sets its text from that field.
- `data-sf-src="field"` on an `<img>` sets its source from that image field.
- `--sf-duration` on the root element is the length of this play. Use it to time the outro: `animation-delay: calc(var(--sf-duration) - 0.7s)`.
- `data-orientation="landscape|portrait"` on the root element. Use it for layout, not a media query, because a letterboxed template is not the shape of the screen.
- `defineTemplate({ prepare, play })` hooks for anything markup cannot do, such as building rows from a list or drawing to a canvas. `prepare` may be async; ready is reported after it resolves. A `stop` hook exists in the SDK but the player does not call it today: a template is simply removed.
- `formatter(ctx, options)` and `dayKey(ctx, date)` format dates and times in the screen's time zone and locale. Use them for anything shown: the device's own clock settings may not match the screen's location.
- `fitWords(text, fits)` shortens text to the whole words that fit, ending in "…": CSS `text-overflow` cuts after a space and shows "rain …". `fits` sets the candidate and checks for overflow (`templates/news/main.ts`); it costs about log2(words) layouts, and only for text that overflows.
- `readableOn(fill, text)` from `@signforge/template-sdk/contrast` is `text` when it reads on `fill` (4.5:1), else black or white, whichever reads better; `readableOn(fill, text, { large: true })` asks 3:1, for large text (below). Use it for text on a fill the template does not choose: a colour field (news's badge on the spot's accent) or a kit's colour, whose on-colour a kit may set by hand to a pair that fails (cstore-promo's badge, photo-promo's price tag). Use it the other way round for accent-coloured text, `readableOn(background, accent)`, measured against what the text really sits on: news's age line on `--bg`, clock's greeting on `--bg` under its accent glow, menu-board's prices on their card, cstore-promo's promo line on the copy panel over the stage. Colours are `#rgb` or `#rrggbb`; a `color-mix` comes back from `getComputedStyle` as `color(srgb …)`, and a translucent card shows what is under it, so resolve the backdrop first with `painted(...layers)` from the same entry point, bottom first, a layer a colour or `[colour, opacity]` (menu-board: `painted(bg, getComputedStyle(card).backgroundColor)`). It reads a 1×1 canvas, so call it once per backdrop, not per row (agenda keeps one per kind of card). Text over a gradient is measured over both ends (agenda's stage, cstore-promo's). It is a separate entry point so that templates which do not use it keep their bundles byte for byte.
- `readableOver(pixels, text, { large, lightest })` from `@signforge/template-sdk/backdrop` is the same for a backdrop that is not one colour, text over a photo: given the RGBA pixels behind the text, it is `text` when it reads on every one, else black or white when one of them does, else undefined, and the text needs a fill of its own. With `lightest`, the pixels are an image's sample: each cell's darkest pixel in `pixels` and its lightest at the same place in `lightest`, and the text must read on every colour between the two.
  - **Read the sample, not the photo.** An image uploaded or built since #169 has a sample (`ManifestFile.sample` in the contract): its darkest and lightest pixel in each cell of `IMAGE_SAMPLE_CELL` (16) px, as a PNG of the darkest cells over the lightest. `init` carries it beside the image, as `ctx.assets[sampleAsset(field)]` (both from the same entry point). Drawing the photo into a canvas decodes it again on the main thread, whatever the size of the part read: 70 ms of a Pi's prepare for a 1080p photo. The sample is a few hundred times fewer pixels.
  - **Do not wait for the photo, and do not let it paint, while `prepare` runs.** Before `ready` the SDK awaits `img.decode()`, and the first frame's raster decodes the photo again; the two run one after the other, off the main thread, about 100 ms on a Pi. When a frame paints the loaded photo while `prepare` is still running, the raster's decode is scheduled first and the SDK's waits behind it, so `ready` waits for both: on the Pi that, not the canvas, was most of what #168 cost (`spike/pi-perf/RESULTS.md`, Photo samples). So photo-promo hides its photo (`visibility: hidden`) until `prepare` returns, and takes the photo's size from its sample, to the cell, rather than waiting for the photo to load. Calling `img.decode()` early does not help: each call decodes again.
  - **photo-promo's eyebrow** maps the text's box to the photo's pixels, wherever the push-in takes it during the spot, for every size within the cell the photo can be, and draws the sample's cells under that into a canvas, without smoothing, twice over: its darkest cells and its lightest. It paints the shade over each as the shade is at the box's top and at its bottom, and reads that once. A cell is a range, not an average: averaging is what kept the demo kit's orange at 2.88:1 in portrait over a 4K photo, measured one pixel per 4 px (#168). The two are chosen before the shade, so under it a third pixel of the cell can come out a little darker or lighter than both (a search of random pixels found up to 1.16 times the contrast under a dark kit's shade, 1.4 under a light or coloured one). Real photos rarely have such cells, and none of 252 cases measured on screen fell under 3:1. A sample that does not decode, or that the player does not hold yet, leaves the template to measure the photo.
  - **Without a sample** (an image uploaded before samples, or one with transparent pixels), or for a photo painted at more than twice its size, which is small and quick to decode and whose cells would each cover more than 32 px of screen, it waits for the photo to load and draws the photo itself, one pixel per pixel the screen paints it at, without awaiting `img.decode()` first, which decodes it a second time.
  - Where nothing reads, the eyebrow sits on a fill of the kit's background (a scrim) in `readableOn(bg, accent, { large: true })`. Its own entry point for the same reason as `contrast`: any edit to `contrast` renames symbols in every bundle that imports it.
- `qrSvg(text, label)` from `@signforge/template-sdk/qr` draws a `url` field's value as a QR code: an `<svg>` that fills its box, named `label` for screen readers. It is always dark modules on a white tile with the four-module quiet zone readers need, whatever the brand kit: a phone's reader needs dark on light and real contrast, so never recolour it. A longer address means more, smaller modules, so give the tile room and check on the Pi that a phone scans it from where people will stand. Error correction is M (a code still reads with 15% of it lost to glare). Place it in `prepare` (`box.replaceChildren(qrSvg(url, label))`) and leave the box out when the field is empty. Its own entry point, so templates that do not draw a QR code keep their bundles byte for byte; one that does carries the encoder's MIT notice (uqr) at the end of its script, as the licence requires.
- `wallTime(ctx, value)` from `@signforge/template-sdk/wall-time` is the instant a `datetime` field's wall time falls on in the screen's zone (`ctx.timezone`), or a `date` field's day starts on there. Work out what depends on it in `prepare`, from `now()`: a countdown's time to go is `wallTime(ctx, target).getTime() - now().getTime()`, and whether a `date` is today is `dayKey(ctx, now()) === day`. A wall time the clocks skip (02:30 the night they go forward) falls as much later as they jumped (03:30); one they repeat (01:30 the night they go back) is the first. Show the value with `formatter(ctx, …)` on that instant. Its own entry point, so templates that do not read dates keep their bundles byte for byte.
- `now()` is the screen's time: the device clock corrected from the server. Use it, never `new Date()` or `Date.now()`, for anything that depends on the time: a Pi has no battery-backed clock, and after a power cut its own clock can be days out. Something that follows the time without new data, like weather's sun and sky, works out its state in `prepare` from `now()`: the player prepares every play afresh, so it moves on from one play to the next. Round to the minute what should change at most once a minute.
- The screen's brand (protocol 2): see Brand below.

## Brand

When the screen has a brand kit, the player sends it in `init` as `theme`, and before `prepare` the SDK applies it:

- Colours and shape as custom properties on the root (`BRAND_CSS_VARS` in the contract): `--sf-primary`, `--sf-on-primary`, `--sf-accent`, `--sf-on-accent`, `--sf-bg`, `--sf-surface`, `--sf-text`, `--sf-muted`, and `--sf-radius` (square `0px`, soft `12px`, round `9999px`).
- Brand fonts: `--sf-font-display` and `--sf-font-body`, each set when the kit has that font and the template's `<style>` uses that variable. The SDK adds them as `@font-face` rules for `sf-brand-display` and `sf-brand-body` with `data:` URLs (as a template's own fonts arrive; nothing is fetched, and the no-network policy is unchanged) and loads them before `ready`, so the first frame draws with them. A family the template never uses is not loaded: on the Pi, unused faces still slowed the first paint of a large photo. Faces built from bytes (`new FontFace(name, buffer)`) were tried first and dropped: on the Pi about one prepare in three of a template over a 4K photo then took about a second to paint.
- The logo: `<img data-sf-src="$brand.logo">` gets the kit's logo, the on-light version when `--sf-bg` is light and the kit has one, else the on-dark one. It is also `ctx.assets['$brand.logo']`.

Cost on the Pi (`spike/pi-perf/RESULTS.md`, Brand fonts and Slow prepares): a kit costs a template that does not use the brand fonts nothing; drawing in them adds about 0 to 80 ms to a prepare, and with the shipped templates on the brand fonts (M3-25) every stress spot prepares within 500 ms except news loading under a playing video (550 ms, and 1.4 to 1.6 s when the video layer hides the frame underneath: RESULTS.md, Brand tokens and template polish). Measure a template on the Pi after moving it onto the brand fonts.

Write every brand value with a fallback, so the template still draws on a screen with no kit, where nothing is set: `color: var(--sf-text, #f8fafc)`, `font-family: var(--sf-font-display, Inter), sans-serif`, and give the logo `<img>` a `src` of its own (a `data:` URL) or hide it when it has none. Colours built on a token are fine: `color-mix(in srgb, var(--sf-accent, #22d3ee) 30%, transparent)`.

A colour field may default to a brand token, `"$brand.<colour>"` with one of the contract's `BRAND_COLORS` (`"$brand.accent"`). The server's compiler replaces it with the screen's brand colour at publish, so `data` only ever holds colours; a token naming no brand colour is a problem of the spot.

**Colour lint.** `sf build` and the server warn on a colour literal in a template's CSS (`style.css`, and `<style>` in `index.html`) that is not the fallback inside a `var()`: a hex colour, `rgb()`/`hsl()` and the like anywhere, and named colours (`white`) in colour properties. It is a warning: the version still builds and registers, and the warnings are kept on its check report. The shipped templates have none (`packages/cli/test/templates.test.ts` keeps it so). How they get there:

- Give each brand role its token: text `--sf-text`, secondary text `--sf-muted`, page `--sf-bg`, cards `--sf-surface`, filled shapes `--sf-primary` with `--sf-on-primary` text, highlights `--sf-accent`. The brand tools derive an on-colour that reads, but a kit may set one by hand that does not (they only warn), and a colour field's fill is whatever the spot sets: pass such pairs through `readableOn` in `prepare`. With no kit, `$brand.accent` is the default palette's amber (`#f59e0b`), on which white reads at 2.14:1. The accent is not a text colour for every background either: amber on a light kit's white is 2.15:1, so accent-coloured text goes through `readableOn` too. **Large text** is WCAG's: at least 24 px, or 18.66 px (14 pt) bold (700 and up), on the screen, and the screen is 1080p: the Pi 4 is the baseline device and is held at 1080p, so `1vmin` is 10.8 px, in portrait too. So text of `2.23vmin` and up, or `1.73vmin` bold, is large and needs 3:1; smaller text needs 4.5:1. Every shipped accent-coloured text is large (agenda's bold day labels at `2.2vmin` are the smallest, 23.8 px), and all pass `{ large: true }`, so a mid-tone brand accent such as green on white (3.30:1) stays the accent instead of turning black. At 3:1 there is no margin, so the backdrop must be the one the text is painted on: photo-promo's eyebrow, measured on the kit's background and not on the photo under it, kept the demo kit's orange at 1.99:1 over a white photo (#124). Text on a fill keeps 4.5:1. Asking 3:1 is a claim about the text's size: shrink the text below the line and drop the option. `packages/player/browser/templates.test.ts` measures both kinds under no kit, the demo kit, a kit with poor on-colours, a light kit, an accent just over 4.5:1 on the demo kit's background, green on white, blue on dark and an accent just over 3:1 on its background and a mid-tone background, photo-promo over a white, a black, a mid-grey and a black-and-white striped photo, broad and 1 px wide at the screen's scale, in landscape and portrait, with the threshold from each text's size at 1080p, and checks that a kit's accent is kept wherever it reads.
- Shades and shadows are the kit's background mixed with `transparent` (`color-mix(in srgb, var(--sf-bg, #000) 50%, transparent)`), and text over them the kit's text: the kit keeps that pair legible, so a light kit gets a light shade with dark text. A "light" theme option swaps the two (`templates/menu-board`).
- A colour that is not a brand role, such as a weather sky, is a mix of tokens whose two fallbacks are the same literal, so with no kit it is exactly that colour: `color-mix(in srgb, var(--sf-primary, #2f80ed) 75%, var(--sf-bg, #2f80ed))`.
- Canvas drawing is not linted; read a token with `getComputedStyle` to follow the kit (weather's rain and snow).

## Live data

Any non-image field can be bound to a data source instead of a fixed value. The spot names the source and a dot path into it (`current.temperature_2m`, `daily.temperature_2m_max.0`, `events`). The static value is the fallback: it shows until the first data arrives, and whenever the live value does not fit the field. Before a bound value replaces it, the player checks it against the field's definition (type, `maxLength`, `min`/`max`/`step`, `options`, a list's `maxItems` and row fields); a value that is missing at its path or fails is ignored for that spot and counted against its source. So a template can trust its data to have the shape its fields declare, live or not. The check is `boundValue` in `packages/contract` (`validateBoundValue` on the value read), which the server also runs before it stores or sends a snapshot. Data the server has not confirmed for a day is stale, and the static value shows again (`SNAPSHOT_STALE_MS`). A news feed's `language` is always present (`''` when the feed declares none), so the news template binds it to write headline ages in the feed's language.

**Declaring live fields.** A template whose fields come from a feed says so in `live`, so the CMS shows a Source section for them instead of inputs: people choose where the data comes from (a place, a news feed, a calendar), never the values. Each field keeps its definition and default, which are the fallback.

```json
"live": {
  "source": "open-meteo",
  "fields": { "temp": "current.temperature_2m", "high": "daily.temperature_2m_max.0", "code": "current.weather_code" },
  "place": "city",
  "units": { "temperature": "unit", "wind": "windUnit" }
}
```

- `source`: the kind of feed. `open-meteo` is an Open-Meteo forecast (a JSON source; the CMS asks for the `current=` and `daily=` variables the paths read, in the place's time zone, with `timeformat=unixtime`). `rss` is a news feed and `ical` a calendar, which the server converts to `NewsFeed` and `CalendarFeed`, so their paths are those shapes' (`items`, `language`, `events`). `table` is a CSV file or a JSON list at a link (below): its fields must be lists, at `rows`, and they stay typed until a spot binds them.
- `fields`: each live field's path in the snapshot, as a binding names it (`BINDING_PATH`). Not an image field.
- `place` (Open-Meteo only): a text field that starts as the name of the place picked. People may still change it.
- `units` (Open-Meteo only): the select fields that choose the units the forecast is fetched in, `temperature` with options from `°F`, `°C` and `wind` from `mph`, `km/h` (`WEATHER_UNITS`). The CMS sets them with the place, so the numbers and the unit shown always agree.

`validateTemplateManifest` checks all of it. A template with no `live` is typed by people. The base templates: weather (`open-meteo`), news (`rss`: `items`, `language`), agenda (`ical`: `events`), menu-board (`table`: `items`).

**Table bindings.** A `csv` or `json-table` source's snapshot is a `TableFeed`: `columns` and `rows` of text and numbers (`@signforge/feeds`, Tables). A binding with a `table` mapping (`TableMapping`), at path `rows`, fills a list field from its rows:

```json
"items": {
  "source": "lunch-menu",
  "path": "rows",
  "table": {
    "columns": { "name": "Item", "price": "Price", "description": "Notes" },
    "filter": { "column": "Section", "equals": "Mains" },
    "sort": { "column": "Price", "descending": true }
  }
}
```

- Each row becomes an item: the column named for each item property fills it, converted to the property's type. A number written into a text property takes the screen's locale, as a price (4.5 is "4.50" in en-US, "4,50" in de-DE, 12 is "12"); text stays as the file has it ("$4.50"). A select takes its option in any case; a boolean `true`/`yes`/`1` or `false`/`no`/`0`. A date takes `YYYY-MM-DD` and a datetime `YYYY-MM-DDTHH:mm`, also written with a space for the `T` or with `:00` seconds, as spreadsheets export them; any other form (`27/11/2026`, an offset or `Z`) does not fit. An empty cell takes the property's default.
- Every property without a default needs a column. A row that leaves one empty, or does not fit the item (too long, not an option), is left out and named in the screen's rejected data; the rest still show. When every row the filter keeps is left out, the binding has no value: the poller fails the source as `unfit` and keeps the last good snapshot, and a screen keeps what it shows, rather than draw an empty list. A filter that keeps no rows is an empty list.
- `filter` keeps the rows whose cell equals the value, ignoring case and surrounding spaces; `sort` orders by a column (numbers, and text that is one number, by value; a date and time by time, whether written with a `T` or a space; other text in the screen's locale), else the file's order. Then the list is cut to the field's `maxItems`, so a template draws at most that many rows however long the file is. Measured on the Pi: menu-board fed by 24 rows plays as its 12 typed items do (`spike/pi-perf/RESULTS.md`, Table bindings).
- A table without a mapped column gives no items. The poller fails such a source as `missing-column` when a published spot maps the column, keeping the last good snapshot, and the sync and the screen refuse such a snapshot too, whatever else it fills: the last good rows stay on screen. A spot that plays one anyway (from a snapshot kept before the mapping changed) shows its fallback.
- A template that declares a `table` source, or a binding with `table`, needs manifest schema 4 (`MANIFEST_SCHEMA`). A player before #84 plays schemas 2 and 3 and refuses such a template in any manifest, typed items or not; it reports that in its sync, cannot play schema 4, and the server tells it to reload (`canPlay` in apps/api `device/sync.ts`), into a player that plays 3 and 4.
- A table with more cells than any snapshot can hold (columns × rows past half `MAX_SNAPSHOT_BYTES`) is refused as `too-large` before its rows are built.

A spot may still bind any field to any source with the tools (`bindings` on `create_spot` and `update_spot`); `live` is what the editor offers.

The server fetches feeds, never the screen. JSON feeds pass through; calendar (iCal), news (RSS or Atom) and table (CSV, or a JSON list) feeds are converted to fixed shapes, `CalendarFeed`, `NewsFeed` and `TableFeed` in `packages/contract`, so a template binds to the same paths whichever service the data came from. A spot reads the latest data when it starts; data does not change during a play.

## Rules

Each rule comes from a measurement on the baseline device, a Raspberry Pi 4 at 1080p 60 Hz. The numbers are in `spike/pi-perf/RESULTS.md`.

**Layout**
- Size everything relative to the viewport (`vmin`, `vw`, `vh`, `%`). No fixed pixel sizes.
- Handle every orientation you list.
- Read sizes from `ctx.viewport`, not `innerWidth` or `innerHeight`. While a template prepares, its frame may not be laid out yet and the window reports 0.

**Animation**
- Animate `transform` and `opacity` only. Do not animate layout properties such as `width`, `top` or `font-size`.
- No `backdrop-filter`. The build rejects it. A translucent gradient panel gives a similar look for free.
- Prefer effects the browser draws once over CSS `filter`. `box-shadow`, `text-shadow`, gradients and gradient text are rasterized once and cost nothing afterwards. `filter: blur()` and `filter: drop-shadow()` are reapplied on the GPU every frame. One template can afford a few, but a transition puts two templates on screen and doubles the cost. A soft glow is a radial gradient; a product shadow is a blurred-looking radial gradient underneath it.
- At most about 50 elements animating at once.
- For particles (rain, snow, confetti), draw a small seamless tile once, use it as a repeating background, and slide the element by one tile with a CSS animation. Measured on the Pi: under 0.4% dropped. Redrawing a full-screen canvas every frame, or sliding one giant canvas, stalled for up to half a second.
- Do not run a `requestAnimationFrame` loop. Anything that must update over time (a clock) should change text at most once a second.
- Give each element an intro and an outro. The player may crossfade or cut between spots; it does not animate your content.
- Spots can be any length in your range. Do not assume the default duration: derive end-of-spot timing from `--sf-duration`.

**Text**
- Fit the space you have. Clamp long text with `-webkit-line-clamp` or `text-overflow: ellipsis` (or `fitWords` to end on a word), and show as many list rows as fit rather than a fixed count, dropping those that do not fit rather than letting them run off screen (see `templates/agenda/main.ts`).
- Give grid and flex tracks a zero minimum (`minmax(0, 1fr)`, `min-width: 0`). A track's default minimum is its content's width, so one unwrapped line (`nowrap`, a long headline) widens the whole column past the screen and every clamp or ellipsis in it stops working. Found on live news feeds.
- A crawl or ticker is one strip of text holding its content twice, sliding left by exactly one copy. It loops seamlessly and costs nothing measurable.

**Isolation**
- No network. The template runs in a sandboxed frame under a policy that blocks every request, including navigating its own frame: a template that tries is stopped and its spot is skipped. There is no WebRTC either: `RTCPeerConnection` is undefined in the template's frame and in any frame it adds, on screens and in the runtime check. Scripts and styles must be inline after the build, and images arrive from the player.
- Only the bundle's own inline classic scripts run (no `type`, or `text/javascript`), and each must start with exactly `"use strict";` (`sf build` makes one such script: esbuild emits it for a strict TypeScript build). Scripts are read with an HTML parser: a script example shown in a textarea or kept in a comment is text, and is left as written. No script may sit in a `<select>`: browsers parse `<select>` differently, so one there is refused and does not run. Inline modules, external scripts (none is ever requested), inline event handlers (`onclick="…"`, `setAttribute('onload', …)`) and `javascript:` URLs do not: use `addEventListener` or a property (`img.onload = …`). Nor do `eval` and `new Function`.
- No storage, cookies or access to anything outside its own frame.
- Fonts ship inside the bundle. Reference a font file from `style.css` and the build inlines it. Use a font you are licensed to redistribute. Brand fonts are the exception: they come with the theme (see Brand), from the curated catalogue in `fonts/`.
- Data is fixed for one play. New values arrive with the next `init`, from a clean document (see Lifecycle).
- Decoration must not fail the spot. If an optional effect cannot be drawn, catch the error and show the content without it; a template that rejects in `prepare` is skipped.

**Budgets**

| Limit | Value |
| --- | --- |
| Built bundle size | 600 kB |
| `init` to `ready` | 500 ms, brand fonts included |
| Brand font family (all weights, WOFF2) | 150 kB |
| Dropped frames over a play | 1% |
| Longest single frame | 50 ms |

`sf build` and `sf template push` enforce manifest validity, the forbidden-CSS list, bundle size, the no-network rule and the forbidden-code list (`checkTemplateBundle` in `packages/contract`; it refuses network calls, navigation, inline event handlers and `javascript:` URLs) and the script rule (read with an HTML parser: each classic script in HTML or SVG starts with exactly `"use strict";`; no external script, module or other script type, and no script markup in a `<select>`), and warn on colour literals (see Brand). The server repeats the same checks when a version is registered and stores the report on it: the first four on the uploaded bundle, the code list on the author's own `index.html`, `style.css` and `main.ts`, which are uploaded alongside it (the bundle holds the SDK, which itself calls `parent.postMessage`).

These checks are a lint, not a security boundary: string matching can be evaded. What keeps a screen safe is the sandbox the template runs in and its policy that blocks every request.

**The runtime check.** The server then renders an org's new version before registering it (`apps/template-check`; docs/architecture.md, Runtime check): headless Chromium in a container with no network, in the player's own frame and policy, with each field's default (a small image for each image field), at 1920x1080 in each orientation you list. It plays for a second after `ready`. The version is refused with each of these it sees, one sentence each:

- a request of any kind (`requested https://example.com/x (blocked)`), including images, fonts, media, workers and beacons, and anything else the policy blocks (`eval`);
- navigating its own frame, the page around it, a new window or a form;
- an uncaught error, or a `prepare` that rejects. Its frames have no `RTCPeerConnection`, as on a screen, so a template whose use of it throws is refused this way; one that catches the error, or only tests for the constructor, passes (and has no WebRTC on screens either);
- no `ready` within 2 seconds, the player's limit;
- `ready`, then no second of frames within 3 seconds of `play` (`froze after play`): a template wedged in `play`, as a busy loop is, would freeze the screen. Blocking work in `play` is refused once it runs for about 2 seconds, since the second of frames must still fit in the 3.

It runs in your org's own container, which no other org's template shares. A check that could not run (the container busy or not started) refuses the push as `unavailable`: try again. An org may run about 10 checks a minute (the count is kept per Cloudflare location). A pass is stored on the version with its timings (ms from `init` to `ready`, and the first second's frames, per orientation); they are information, not a gate, since the budgets are measured on the Pi. Base templates in `templates/` go through the same runner in CI (`apps/template-check/test/check.test.ts`). Test yours with `sf template push` to an org.

A registered version is immutable: pushing the same version with different bytes is refused, and pushing identical bytes changes nothing. A version is a draft, approved or retired; only approved versions are offered for new spots. The time and frame budgets are measured on the device with `scripts/pi-measure.sh`; automated checks for them are part of Milestone 4. Of the timings, the runtime check refuses only a template that is not ready within 2 seconds or that draws no second of frames within 3 seconds of `play`. It watches only the first second after `play`: a template that stops drawing later is not seen.

So a shipped template's bundle must not change under its version, or `sf template seed` refuses it on the next deploy. A bundle holds the template's own files, the SDK, and from the contract only `@signforge/contract/frame` (the protocol version and the brand variables) and, in a template that reads an image's sample, `@signforge/contract/sample`, so a change to the rest of the contract (the API's, the sync's or the screen's checks) leaves every bundle byte for byte. `packages/cli/test/templates.test.ts` builds every template in `templates/` and compares each bundle's sha256 with `packages/cli/test/golden/template-bundles.json`, by template key: it fails when a bundle changed, whatever changed it. Then bump the version in the template's `template.json` and `package.json`, put the new key and hash in that file (the failure shows both), and regenerate the goldens. A change to the SDK's index can change every bundle, even of templates that do not use the new code (an unused export changed six of seven, and two added to `@signforge/contract/frame` changed all seven; a comment-only edit changed none), because the minifier renames symbols across the whole bundle: SDK code only some templates use goes in its own entry point, as `readableOn` does. An esbuild or bundled-font upgrade turns the test red for every template the same way.

## Review checklist

For a human approving an agent-built template:

1. `sf build` passes with no problems reported, and the version registered, so the runtime check passed (its report is on the version).
2. It looks right in both orientations it lists, at the shortest and longest duration in its range.
3. Long field values do not overflow or overlap (try each text field at its `maxLength`).
4. On the Pi, `device/pi/isolate.py 30 cut <spot>` reports under 1% dropped frames while playing, and no frame over 50 ms.
5. Fonts and any artwork baked into the bundle are ones we may redistribute.
