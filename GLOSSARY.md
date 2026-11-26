# Glossary

Terms the code and the docs use with one meaning. Add a term when a module is named after it.

**Versioned draft**: an edit to a versioned record (a spot, a playlist, a brand kit, a schedule entry, a screen's settings, the org's settings) from the moment it is made to the moment it is saved. It knows the version it started from, saves one at a time, and on a conflict keeps the edit and offers Reload rather than overwrite. It belongs to the org it was made in. One module in the CMS (`apps/cms/src/state`) owns it for every editor.
_Avoid_: form state, optimistic update.

**Tool services**: what a tool may use beyond its input and the org's data: sealing a URL, sending an alert now, telling screens, checking a template, providers' OAuth, sealing and testing an org's model key, rate limits. A caller (the CMS's, an agent's, a test's) carries them; each tool says which it needs, and a call without one is refused before the tool runs.
_Avoid_: dependencies, context fields.

**Draft to spot**: turning a spot's draft (as `get_spot` gives it) into the contract's `Spot` for one orientation, and compiling the probe screen a draft is checked on. One module (`@signforge/compiler/draft`) does it for the publish and the CMS's stage; each reads assets and template versions its own way (`DraftReads`). Only a verified asset gives a spot a file, on both sides.
_Avoid_: preview conversion, toSpot.

**Rollout outcome**: where a screen a publish switched stands on the manifest it gave it (playing, replaced, revoked, or open: waiting, downloading, asleep, unreachable, fell back), and whether the rollout is over (no screen open). One module (`packages/tools/src/rollout.ts`) decides it for `get_publish`, `list_publishes` and the five-minute check that marks a publish finished and sends its alert; `packages/db` reads only the facts it is decided from.
_Avoid_: rollout status, applied.

**Label**: a `key=value` fact about a screen (`region=north`, `store=0142`, `type=drive-thru`) set with `update_screen_labels`, at most one value per key. The value is stored as typed and matched case-insensitively. A location is just a label key; there is no built-in location. Only `org.screens.labels` in `packages/db` touches the `screen_labels` table. Screens never see labels.

**System label**: a label every screen has from its settings, read-only and never stored: `orientation`, `kind` (device or browser), `timezone`, and `locale` when it has one. A selector reads them as labels, so `orientation=portrait` needs no one to type it. Their keys cannot be set as labels.

**Selector**: which screens to pick by their labels and system labels: every term holds (`{ all: [{ key, op, values }] }`, at most 10 terms; `eq`, `neq`, `in`, `notin`, `exists`, `missing`), written for people as `region=north, type in (drive-thru, kiosk), !legacy`. A key a screen lacks equals nothing, so `region!=north` skips a screen with no region. One pure module (`@signforge/compiler/selector`: `matches`, `format`) decides it for `list_screens`, and will decide it for the CMS's preview and the publish, so they never disagree. A selector cannot name a screen's name, id or status.

**Frame host**: the screen's side of the template frame protocol: given a bundle's contained frames (`containedFrames`), it builds the wrapper frame and the sandboxed template frame, answers the template's `loaded` with `init`, waits for `ready` or `error` (the time from `init` to `ready`), sends `play` and `reset`, and removes a template that navigates its own frame. One module (`packages/player-core/src/frame-host.ts`, #331); the player's `Slot` decides what `init` carries and when a spot shows.
_Avoid_: template host, iframe wrapper.

**Bound fields**: the fields a data source feeds (each spot's bindings to it, with its template's field definitions, in a locale a screen plays in), and whether a snapshot of it may replace the last good one. One module (`packages/player-core/src/bound.ts`) answers it for the player, the sync and the poller; the screen's locale, or for the poller every locale the org's screens play in.
_Avoid_: fit, fitting fields.

**Feed photos**: a news story's photo across its whole life, from the RSS poll that names it through fetching, checking, scaling, storing and weekly rechecking to expiring its row and deleting its blob under `o/<org>/f/<sha256>`. One module owns it in two halves: `packages/db/src/feed-photos.ts` (`org.feedPhotos`, composed into `OrgScope`, with its `sourceEdited` and `pollSave` rules applied inside `org.dataSources.stage.update` and `org.dataSources.savePoll`, and the cross-org sweep finders in `packages/db/src/retention.ts` sharing its rules and constants) owns the D1 state, read token, read-afresh rule, snapshot-reference rule, holds, daily budgets, delete leases and timing constants; `apps/api/src/data/feed-photos.ts` owns fetching, checking, scaling, the `o/<org>/f/` key prefix, and the `PhotoBlobs` and `PhotoQueue` ports. Callers (`poller.ts`, `save_data_source`, the queue consumer and the 01:00 UTC cron) say what happened; the module decides what follows.
