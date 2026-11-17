# M3-35 Tool output schemas and pagination

Status: open  ·  Size: S  ·  Depends on: nothing

## Goal

Fix the tool conventions before the editor adds many tools (Fable): every tool declares what it returns, and lists page.

## Read first

- packages/tools/src/tool.ts, dispatch.ts, the registry

## Scope

- Each tool declares an output schema; `dispatch()` checks output in tests (not in production).
- List tools take `limit` and `cursor` and return `next`. Default and maximum limits documented.
- A guard test that fails on a tool without an output schema, or a list tool without paging.

## Done when

- [ ] Every registered tool has an output schema and the guard test passes.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
