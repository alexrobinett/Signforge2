# M3-43 Command menu

Status: done (branch m3-43-command-menu)  ·  Size: S  ·  Depends on: M3-11

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

- [x] Every tool the role allows appears, and none it does not (test against the registry). `apps/cms/test/registry/command-menu.test.ts` builds the menu from `describeTools(registry, { role })` for owner, editor and viewer and compares it with the registry: owner all tools, editor all but the owner-only ones, viewer the read tools only. The menu shows exactly what `GET /api/tools` returns, which is that list.
- [x] Keyboard only: open, filter, run, close. `apps/cms/e2e/command-menu.spec.ts` (Playwright): Ctrl/⌘+K opens with focus in the search, typing filters, Enter on "Pair a screen" opens its form, Tab/type/Enter pairs a real screen (toast), `list_screens` runs at once (toast), a `rename_screen` refusal shows the API's message and keeps the form, Escape closes, "go to screens" + Enter navigates, Ctrl/⌘+K closes again.
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated (apps/cms/README.md: "Command menu", layout, checks).

Notes: no tool or page has a keyboard shortcut yet, so no entry shows one; the menu has no shortcut column until something defines one. Screen and spot nouns (the board's "Screens" group and "Selected:" row) are not in this ticket's scope; on a screen's page its `screenId` fills the form's field instead.
