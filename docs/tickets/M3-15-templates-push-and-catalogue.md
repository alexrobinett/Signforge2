# M3-15 Templates: push and catalogue

Status: open  ·  Size: S  ·  Depends on: M3-12

## Goal

Get built templates into the system with the build's checks repeated on the server.

## Read first

- docs/template-spec.md
- packages/cli/src/sf.ts (`buildTemplate`)
- packages/contract (FORBIDDEN_CSS, FORBIDDEN_TEMPLATE_CODE, TEMPLATE_BUDGET)

## Scope

- `sf template push <dir>`: build locally, upload bundle and `template.json`.
- Server repeats manifest validation, forbidden CSS, size and network checks on the bundle; stores a check report.
- Base templates (org null) seeded from `templates/` on deploy.
- Versions are immutable; a template version is draft, approved or retired.
- Server checks are a lint over the bundle, not a security boundary (the SDK itself calls `parent.postMessage`). Check the author's sources where the CLI uploads them; record that the sandbox is the guarantee.

## Out of scope

- The agent submission pipeline and review UI (Milestone 4).

## Done when

- [ ] All seven templates in `templates/` push and appear as approved base templates.
- [ ] A bundle with a `fetch` call or `backdrop-filter` is rejected with the reason.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
