# M3-35 Tool output schemas and pagination

Status: done (branch m3-35-tool-output-schemas)  ·  Size: S  ·  Depends on: nothing

## Goal

Fix the tool conventions before the editor adds many tools (Fable): every tool declares what it returns, and lists page.

## Read first

- packages/tools/src/tool.ts, dispatch.ts, the registry

## Scope

- Each tool declares an output schema; `dispatch()` checks output in tests (not in production).
- List tools take `limit` and `cursor` and return `next`. Default and maximum limits documented.
- A guard test that fails on a tool without an output schema, or a list tool without paging.

## Done when

- [x] Every registered tool has an output schema and the guard test passes. (`packages/tools/test/conventions.test.ts`: output schema on all 22 org and platform tools, paging on the four `list_*` tools; the output check is on in the tools and api test setups and was seen to fail a deliberately broken `list_screens` through `/api/tools`.)
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated. (Both green after merging `m3-foundations`; `packages/tools/README.md` covers output schemas, `outputSchema` in `GET /api/tools`, paging limits and the conventions test.)
