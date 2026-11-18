# M3-23 Data source poller

Status: done except the Pi check (branch m3-23-data-source-poller)  ·  Size: M  ·  Depends on: M3-22, M3-07, M3-12

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

- [ ] The stress playlist's weather, holidays and news update on the Pi with `datad` stopped. **Not run: the rig lock was held by `pi-linux-tuning` for the whole hour I waited (00:26 to 01:29, extended to 02:08); the Pi was not touched.** Done locally instead: the poller, under `wrangler dev --env dev --test-scheduled`, fetched the stress project's real weather (open-meteo), holidays (Google's US holidays iCal) and news (NPR RSS) through the guards and DNS over HTTPS, and stored all three (679, 1,085 and 1,567 bytes). That run found a bug the stubbed tests could not, now fixed with a test: workerd's `fetch` refuses to be called as a method of the guards object.
  Steps (scripts in `~/.signforge-agent-notes/m323-scripts/`):
  1. `pnpm build:player`, and `examples/stress` built with media (`sh scripts/stress-media.sh`, then `tsx packages/cli/src/sf.ts build examples/stress --out $S/stress`). Copy `dist/player` to `$S/player-m323`, and a build from `origin/master` to `$S/player-master`.
  2. `cd apps/api && pnpm exec wrangler dev --env dev --ip 0.0.0.0 --port 8789 --inspector-port 9339 --test-scheduled` (2-hour background timeout).
  3. `pnpm dev:screen --content $S/stress --sources ../../examples/stress/data-sources.json --org m323 > $S/cred` (sealed, real sources, due now).
  4. `sh device/pi/pi-lock.sh take M3-23 "<what for>" 45`, then `S=... sh pi-setup.sh` (records whether `signforge-datad` was active, stops it, backs up the credential, installs this branch's player and an API kiosk.env, resets the kiosk). Fix the Mac's IP in its URL first.
  5. Poll each minute: `while :; do curl -s 'localhost:8789/__scheduled?cron=*+*+*+*+*'; sleep 60; done`. On the Pi, `python3 /tmp/m307.py eval "JSON.stringify(__sf.data)"` shows each source's `fetchedAt`; weather (`refreshS` 60, open-meteo's current values change every 15 min) and news change within the session, holidays arrive on the first sync. Take `m307.py shot weather-live`, `holidays` and `news` screenshots, and confirm `systemctl is-active signforge-datad` is inactive.
  6. `S=... REPO=... sh pi-restore.sh`: master player, `kiosk.env` = `kiosk.env.cloud`, credential back, datad restarted if it ran before, kiosk reset and playing, lock released.
- [x] Tests show each fetch guard rejecting its case. `apps/api/test/data-fetch.test.ts`, one test per guard on a stubbed fetch and resolver (no network): not https (http, ftp, file), a non-default port, IP literals (dotted, IPv6, `2130706433`, `0x7f.1`, `127.1`), local names and hosts resolving to private, CGNAT, loopback, IPv4-mapped and unique-local addresses, a host that does not resolve, a 4th redirect, a redirect to http or to a private host (never requested), the 5-second timeout, Cloudflare's 1003/1016 refusals as `blocked-address`, an error status by category without the body, and a body over 1 MB. The poller records each as `last_error` (`test/poller.test.ts`).
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated. Both pass after merging `origin/master` (api 133, tools 168, player 105, contract 92, db 57, feeds 27 tests); `pnpm lint`, `format:check`, `knip`, `dupes` (0.77%) and `scripts/check-contract-commits.sh` pass too. Updated: `docs/backend-plan.md` (Data sources, Data model, Build order), `docs/architecture.md`, `docs/template-spec.md`, `packages/feeds/README.md`, `packages/db/README.md`, `packages/tools/README.md`. `datad.py` and its service are deleted and `scripts/deploy-pi.sh` removes them from the Pi.
