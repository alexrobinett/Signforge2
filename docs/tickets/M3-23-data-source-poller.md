# M3-23 Data source poller

Status: in progress (branch m3-23-data-source-poller)  ·  Size: M  ·  Depends on: M3-22, M3-07, M3-12

## Goal

Fetch feeds on a schedule in the Worker and deliver snapshots to screens; retire `datad.py`.

## Read first

- docs/backend-plan.md#data-sources

## Scope

- Data source CRUD tools; feed URLs encrypted at rest.
- A one-minute Cron Trigger polls due sources: conditional requests, backoff to 6 hours, write only on change.
- Fetch guards: https only, default ports, no IP literals, private-range check, manual redirects (3 max), 5-second timeout, categorised errors.
- Per-org limits from the plan.
- Snapshot shape: add a content `version` (hash) and `checkedAt`, a staleness limit after which a screen shows the static fallback, and the 64 kB cap, in `packages/contract`. Retire `refreshS` as a screen-side poll interval.
- `packages/feeds` caps a recurring event at 500 occurrences counted from its first, so a daily event begun more than about 500 days ago shows nothing. Raise the cap or start expansion near `now` (see `packages/feeds/README.md`).
- Calendar sources carry a look-ahead (`horizonDays`, as `sf feeds` reads from `data-sources.json`): a holiday board needs months, a meeting room days. Store it on the data source and pass it to `parseCalendar`.
- News language: carry the feed's language (RSS `<language>`, Atom `xml:lang`) into `NewsFeed` (contract first, own commit) so the news template's age label is in the feed's language, falling back to the screen's locale. The visual re-review found a French feed labelled "11 minutes ago".

## Out of scope

- Push of snapshots outside sync.

## Done when

- [ ] The stress playlist's weather, holidays and news update on the Pi with `datad` stopped.
- [x] Tests show each fetch guard rejecting its case. `apps/api/test/data-fetch.test.ts`, one test per guard on a stubbed fetch and resolver (no network): not https (http, ftp, file), a non-default port, IP literals (dotted, IPv6, `2130706433`, `0x7f.1`, `127.1`), local names and hosts resolving to private, CGNAT, loopback, IPv4-mapped and unique-local addresses, a host that does not resolve, a 4th redirect, a redirect to http or to a private host (never requested), the 5-second timeout, Cloudflare's 1003/1016 refusals as `blocked-address`, an error status by category without the body, and a body over 1 MB. The poller records each as `last_error` (`test/poller.test.ts`).
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated. Both pass after merging `origin/master` (api 133, tools 168, player 105, contract 92, db 57, feeds 27 tests); `pnpm lint`, `format:check`, `knip`, `dupes` (0.77%) and `scripts/check-contract-commits.sh` pass too. Updated: `docs/backend-plan.md` (Data sources, Data model, Build order), `docs/architecture.md`, `docs/template-spec.md`, `packages/feeds/README.md`, `packages/db/README.md`, `packages/tools/README.md`. `datad.py` and its service are deleted and `scripts/deploy-pi.sh` removes them from the Pi.
