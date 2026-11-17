# M3-13 Server manifest compiler

Status: done (m3-13-compiler)  ·  Size: M  ·  Depends on: M3-02

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
- Manifest id exactly as the contract defines it (`manifestIdInput`, full SHA-256).
- Template keys namespaced by owner (`base/` or org id), with the contract and player updated to match.

## Out of scope

- Image scaling and video checks (those happen at upload).

## Done when

- [x] Golden tests: `examples/demo` and `examples/stress` compile through the compiler to the same manifests the old `sf build` produced, apart from `generatedAt` (verified before the deliberate changes below; goldens now in `packages/cli/test/golden`).
- [x] Output passes `validateManifest`.
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.

## Notes

- Seams: `compileScreen()` (targeting, defaults, problems, pruning, stable ids) and `sf build`'s golden output (`packages/cli/test/golden`).
- A screen's manifest carries only what its schedule can reach (owner decision, 2026-11-17).
- The input is the compiler's own `CompileInput`, not database rows: M3-02's repositories map onto it, so the compiler does not depend on the schema.
- Goldens were then regenerated, deliberately, for manifest schema 2 (`<owner>/` template keys, its own contract commit). Pruning changed nothing in the examples: everything in them is reachable.
- The golden test compares template bundles by key, not bytes: the minifier renames variables whenever bundled SDK or contract code changes, which is not compiler behaviour.
- Every spot and schedule entry is checked, reachable or not, and spot and manifest problems are reported in one pass.
