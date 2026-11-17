# M3-24 Hardening and environments

Status: open  ·  Size: M  ·  Depends on: M3-23, M3-19, M3-21, M3-37

## Goal

Make Milestone 3 safe to leave running: quotas, cleanup, environments, and a public demo baseline.

## Read first

- docs/backend-plan.md#risks

## Scope

- Per-org quotas: storage, screens, data sources.
- Blob cleanup: R2 objects no manifest or asset references, older than 7 days.
- dev, demo and prod deployed with one command each; secrets documented.
- Audit log view in the CMS.
- Reconnect jitter checked under an API deploy with many simulated screens.
- Player releases: the API hosts content-addressed player builds; sync names the release a screen should run; the supervisor downloads, verifies and swaps it.
- URL spots: at publish, check the page allows framing (`X-Frame-Options`, `frame-ancestors`), since a blocked page still fires `load`.

## Out of scope

- Billing.

## Done when

- [ ] A deploy to demo and prod from a clean checkout works from the documented command.
- [ ] Cleanup deletes only unreferenced blobs: tested.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.

## Owner decision

Q6: per-org limits, given no billing. Default if unanswered: 2 GB storage, 25 screens, 10 data sources.
