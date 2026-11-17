# M3-22 Feed normalisers

Status: done  ·  Size: S  ·  Depends on: nothing

## Goal

`packages/feeds`: iCal, RSS and Atom to the contract's `CalendarFeed` and `NewsFeed`, in TypeScript, with recurrence.

## Read first

- device/pi/datad.py (current behaviour)
- packages/contract (CalendarFeed, NewsFeed)

## Scope

- Port `datad.py`'s parsing with fixtures from real feeds (Google, Outlook, NPR, an Atom feed).
- RRULE expansion with EXDATE and RECURRENCE-ID over the next 30 days; caps on body size, iterations, events.
- Reject XML with DOCTYPE or entity declarations.

## Out of scope

- Fetching and scheduling (M3-23).

## Done when

- [x] Fixture tests pass, including a weekly recurring meeting with one cancelled and one moved instance.
- [x] Runs inside workerd (vitest pool).
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
