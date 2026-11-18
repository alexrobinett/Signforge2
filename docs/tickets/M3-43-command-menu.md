# M3-43 Command menu

Status: open  ·  Size: S  ·  Depends on: M3-11

## Goal

⌘K over every CMS page, built from the same tool registry agents use, so people and agents share one set of actions.

## Read first

- Design: the design canvas (https://claude.ai/artifact/JUMHm7PCsat6RV8yDXNb3H), `docs/proposals/cms-ui.md` and `docs/research/cms-ux.md`. (Idea 7 · ⌘K)
- packages/tools (registry, `describeTools`, output schemas)

## Scope

- shadcn `command` in a dialog, opened with ⌘K / Ctrl+K; navigation entries plus one entry per tool the member's role allows, named from the tool's description, with its shortcut where it has one.
- A picked tool opens its form (fields from the tool's input schema) or runs at once when it needs no input; results and refusals as toasts.
- No motion on open (research: none on things used constantly).

## Done when

- [ ] Every tool the role allows appears, and none it does not (test against the registry).
- [ ] Keyboard only: open, filter, run, close.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
