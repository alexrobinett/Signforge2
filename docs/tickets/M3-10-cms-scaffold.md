# M3-10 CMS scaffold

Status: open  ·  Size: M  ·  Depends on: M3-09

## Goal

Create `apps/cms`, a TanStack Start app on Workers that signs in and talks to the API.

## Read first

- docs/backend-plan.md#layout
- docs/architecture.md#platform

## Scope

- TanStack Start, React 19, Tailwind, shadcn. Same hostname as the API; API reached by service binding.
- Sign-in page, org switcher, an empty dashboard shell with navigation for Screens, Spots, Playlists, Schedule, Assets.
- WebMCP is not wired yet, but leave the tool registry (M3-12) as the only way pages change data.

## Out of scope

- Any feature page.

## Done when

- [ ] Runs locally against the local API; signs in; switches org.
- [ ] Lighthouse accessibility score of 95 or more on the shell.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
