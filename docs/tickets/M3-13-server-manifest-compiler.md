# M3-13 Server manifest compiler

Status: open  ·  Size: M  ·  Depends on: M3-02

## Goal

`packages/compiler`: org data plus a screen in, `ScreenManifest` out. The same output `sf build` gives today.

## Read first

- packages/cli/src/sf.ts (the logic to lift)
- packages/contract (ScreenManifest)
- examples/demo, examples/stress

## Scope

- A pure function, no I/O: takes the rows a publish loads, returns one manifest per screen.
- Manifest id is the hash of the body without `generatedAt`, so unchanged screens are skipped.
- Resolves template defaults, bindings, data sources, display hours, schedule targets (org, group, screen).
- `sf build` switches to it, so the CLI and the server cannot drift.

## Out of scope

- Image scaling and video checks (those happen at upload).

## Done when

- [ ] Golden tests: `examples/demo` and `examples/stress` compile to manifests equal to today's `sf build` output, apart from `generatedAt`.
- [ ] Output passes `validateManifest`.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
