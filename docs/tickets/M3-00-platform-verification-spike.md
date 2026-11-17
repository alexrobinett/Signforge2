# M3-00 Platform verification spike

Status: open  ·  Size: M  ·  Depends on: nothing

## Goal

Settle every **verify** item in `docs/backend-plan.md` with a small, throwaway proof on real Cloudflare, before slices depend on them.

## Read first

- docs/backend-plan.md (every **verify**)

## Scope

- Better Auth with the organization plugin on D1: create org, invite, accept, all without interactive transactions.
- Durable Object WebSocket hibernation: confirm auto-response pings do not wake the object, and how duration is billed per wake.
- mp4box.js (or equivalent) parsing an MP4 header inside workerd from an R2 range read.
- ical.js bundling and RRULE expansion inside workerd.
- Whether `fetch` from a Worker can reach private or loopback addresses.
- D1 foreign-key enforcement, and the Queue and subrequest limits the publish fan-out relies on.

## Out of scope

- Production code. Keep the proofs in `spike/m3-platform/`.

## Done when

- [ ] `spike/m3-platform/RESULTS.md` answers each item yes or no with the evidence and the version tested.
- [ ] `docs/backend-plan.md` has every **verify** replaced with the finding, or a changed plan where the answer was no.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
