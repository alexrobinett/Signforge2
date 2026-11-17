# M3-12 Tool registry and audit log

Status: open  ·  Size: M  ·  Depends on: M3-09

## Goal

One registry of operations that the CMS, the MCP server and WebMCP all call.

## Read first

- docs/backend-plan.md#auth-and-tenancy (agents)
- docs/architecture.md#agents

## Scope

- `packages/tools`: each tool has a zod input, required scope, minimum role, and a handler taking `scoped(db, orgId)`.
- A dispatcher that checks role and scope, runs the tool, and writes `audit_log` for every change.
- Port the screen operations from M3-08 and M3-11 onto it; retire the M3-04 admin route.
- A generated isolation test: every tool, called as org B with org A's ids, returns not found.

## Out of scope

- The MCP server and WebMCP adapters (Milestone 4).

## Done when

- [ ] Every write in the API goes through the dispatcher: a test enumerates routes and fails on one that does not.
- [ ] The audit log records actor kind and id for each change.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.

## Owner decision

Q7: can editors publish, or only owners. Default if unanswered: owners and editors publish; viewers read.
