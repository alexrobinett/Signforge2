# SignForge template spec

Version 1. This is what a template author, human or agent, builds against and what a reviewer checks. The types and limits here are defined in code in `packages/contract/src/index.ts`; if the two disagree, the code is right.

Working examples are in `templates/`: `cstore-promo` (price promotion), `photo-promo` (full-screen photo), `weather` (live data, canvas-drawn rain and snow), `clock` (live time), `agenda` (calendar feed, list field), `news` (RSS feed, scrolling crawl) and `menu-board` (static list).

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
  "version": "1.0.0",
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
- `fields`: what the CMS form shows. Types are `text`, `number`, `boolean`, `color`, `select`, `image` and `list`. A `list` is repeating rows (menu items, events, headlines): it declares an `item` with its own scalar fields and an optional `maxItems`. Every non-image field needs a `default` or the spot must supply a value.
- `duration`: a spot may run for any length inside `minMs` to `maxMs`.
- `orientations`: `landscape`, `portrait` or both.
- `uses`: list `canvas`, `webgl` or `audio` if the template needs them.
- `background`: the colour shown around the template when it is letterboxed on an orientation it does not support.

## Lifecycle

The player and the template talk only through messages. The SDK handles all of it.

1. The template loads and reports `loaded`.
2. The player sends `init` with the spot's data, its image files, the duration of this play, the orientation, the viewport size, and the screen's time zone and locale.
3. The SDK fills in the data, waits for fonts and images to decode and for the result to be painted, pauses every animation, and reports `ready`.
4. When the spot goes on screen the player sends `play`. Every animation restarts from zero.
5. The player removes the template when the spot's duration is up. The template is not asked.

A template that has not reported `ready` within 2 seconds is skipped.

## What the SDK gives you

- `data-sf="field"` on an element sets its text from that field.
- `data-sf-src="field"` on an `<img>` sets its source from that image field.
- `--sf-duration` on the root element is the length of this play. Use it to time the outro: `animation-delay: calc(var(--sf-duration) - 0.7s)`.
- `data-orientation="landscape|portrait"` on the root element. Use it for layout, not a media query, because a letterboxed template is not the shape of the screen.
- `defineTemplate({ prepare, play })` hooks for anything markup cannot do, such as building rows from a list or drawing to a canvas. `prepare` may be async; ready is reported after it resolves. A `stop` hook exists in the SDK but the player does not call it today: a template is simply removed.
- `formatter(ctx, options)` and `dayKey(ctx, date)` format dates and times in the screen's time zone and locale. Use them for anything shown: the device's own clock settings may not match the screen's location.

## Live data

Any non-image field can be bound to a data source instead of a fixed value. The spot names the source and a dot path into it (`current.temperature_2m`, `daily.temperature_2m_max.0`, `events`). The static value stays as the fallback until the first data arrives.

The server fetches feeds, never the screen. JSON feeds pass through; calendar (iCal) and news (RSS or Atom) feeds are converted to fixed shapes, `CalendarFeed` and `NewsFeed` in `packages/contract`, so a template binds to the same paths whichever service the data came from. A spot reads the latest data when it starts; data does not change during a play.

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
- Fit the space you have. Clamp long text with `-webkit-line-clamp` or `text-overflow: ellipsis`, and drop list rows that do not fit rather than letting them run off screen (see `templates/agenda/main.ts`).
- Give grid and flex tracks a zero minimum (`minmax(0, 1fr)`, `min-width: 0`). A track's default minimum is its content's width, so one unwrapped line (`nowrap`, a long headline) widens the whole column past the screen and every clamp or ellipsis in it stops working. Found on live news feeds.
- A crawl or ticker is one strip of text holding its content twice, sliding left by exactly one copy. It loops seamlessly and costs nothing measurable.

**Isolation**
- No network. The template runs in a sandboxed frame under a policy that blocks every request, including navigating its own frame: a template that tries is stopped and its spot is skipped. Scripts and styles must be inline after the build, and images arrive from the player.
- No storage, cookies or access to anything outside its own frame.
- Fonts ship inside the bundle. Reference a font file from `style.css` and the build inlines it. Use a font you are licensed to redistribute.
- Data is fixed for one play. New values arrive with the next `init`.
- Decoration must not fail the spot. If an optional effect cannot be drawn, catch the error and show the content without it; a template that rejects in `prepare` is skipped.

**Budgets**

| Limit | Value |
| --- | --- |
| Built bundle size | 600 kB |
| `init` to `ready` | 500 ms |
| Dropped frames over a play | 1% |
| Longest single frame | 50 ms |

`sf build` and `sf template push` enforce manifest validity, the forbidden-CSS list, bundle size, the no-network rule and the forbidden-code list (`checkTemplateBundle` in `packages/contract`). The server repeats the same checks when a version is registered and stores the report on it: the first four on the uploaded bundle, the code list on the author's own `index.html`, `style.css` and `main.ts`, which are uploaded alongside it (the bundle holds the SDK, which itself calls `parent.postMessage`).

These checks are a lint, not a security boundary: string matching can be evaded. What keeps a screen safe is the sandbox the template runs in and its policy that blocks every request.

A registered version is immutable: pushing the same version with different bytes is refused, and pushing identical bytes changes nothing. A version is a draft, approved or retired; only approved versions are offered for new spots. The time and frame budgets are measured on the device with `scripts/pi-measure.sh`; automated checks for them are part of Milestone 4.

## Review checklist

For a human approving an agent-built template:

1. `sf build` passes with no problems reported.
2. It looks right in both orientations it lists, at the shortest and longest duration in its range.
3. Long field values do not overflow or overlap (try each text field at its `maxLength`).
4. On the Pi, `device/pi/isolate.py 30 cut <spot>` reports under 1% dropped frames while playing, and no frame over 50 ms.
5. Fonts and any artwork baked into the bundle are ones we may redistribute.
