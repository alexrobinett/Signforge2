# Glossary

Terms the code and the docs use with one meaning. Add a term when a module is named after it.

**Versioned draft**: an edit to a versioned record (a spot, a playlist, a brand kit, a schedule entry, a screen's settings, the org's settings) from the moment it is made to the moment it is saved. It knows the version it started from, saves one at a time, and on a conflict keeps the edit and offers Reload rather than overwrite. It belongs to the org it was made in. One module in the CMS (`apps/cms/src/state`) owns it for every editor.
_Avoid_: form state, optimistic update.

**Tool services**: what a tool may use beyond its input and the org's data: sealing a URL, sending an alert now, telling screens, checking a template, providers' OAuth, rate limits. A caller (the CMS's, an agent's, a test's) carries them; each tool says which it needs, and a call without one is refused before the tool runs.
_Avoid_: dependencies, context fields.

**Draft to spot**: turning a spot's draft (as `get_spot` gives it) into the contract's `Spot` for one orientation, and compiling the probe screen a draft is checked on. One module (`@signforge/compiler/draft`) does it for the publish and the CMS's stage; each reads assets and template versions its own way (`DraftReads`). A spot can play and still not publish: an asset still being checked.
_Avoid_: preview conversion, toSpot.
