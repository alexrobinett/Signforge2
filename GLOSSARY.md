# Glossary

Terms the code and the docs use with one meaning. Add a term when a module is named after it.

**Versioned draft**: an edit to a versioned record (a spot, a playlist, a brand kit, a schedule entry, a screen's settings, the org's settings) from the moment it is made to the moment it is saved. It knows the version it started from, saves one at a time, and on a conflict keeps the edit and offers Reload rather than overwrite. It belongs to the org it was made in. One module in the CMS (`apps/cms/src/state`) owns it for every editor.
_Avoid_: form state, optimistic update.

**Tool services**: what a tool may use beyond its input and the org's data: sealing a URL, sending an alert now, telling screens, checking a template, providers' OAuth, rate limits. A caller (the CMS's, an agent's, a test's) carries them; each tool says which it needs, and a call without one is refused before the tool runs.
_Avoid_: dependencies, context fields.

**Draft to spot**: turning a spot's draft (as `get_spot` gives it) into the contract's `Spot` for one orientation, and compiling the probe screen a draft is checked on. One module (`@signforge/compiler/draft`) does it for the publish and the CMS's stage; each reads assets and template versions its own way (`DraftReads`). Only a verified asset gives a spot a file, on both sides.
_Avoid_: preview conversion, toSpot.

**Rollout outcome**: where a screen a publish switched stands on the manifest it gave it (playing, replaced, revoked, or open: waiting, downloading, asleep, offline, fell back), and whether the rollout is over (no screen open). One module (`packages/tools/src/rollout.ts`) decides it for `get_publish`, `list_publishes` and the five-minute check that marks a publish finished and sends its alert; `packages/db` reads only the facts it is decided from.
_Avoid_: rollout status, applied.

**Bound fields**: the fields a data source feeds (each spot's bindings to it, with its template's field definitions, in a locale a screen plays in), and whether a snapshot of it may replace the last good one. One module (`packages/player-core/src/bound.ts`) answers it for the player, the sync and the poller; the screen's locale, or for the poller every locale the org's screens play in.
_Avoid_: fit, fitting fields.
