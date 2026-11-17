# M3-12 Tool registry and audit log

Status: done (branch `t3/m3-12-tool-registry-audit-log`)  ·  Size: M  ·  Depends on: M3-09

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

- [x] Every write in the API goes through the dispatcher: a test enumerates routes and fails on one that does not (`apps/api/test/routes.test.ts`).
- [x] The audit log records actor kind and id for each change (`packages/tools/test/dispatch.test.ts`, `apps/api/test/routes.test.ts`, `apps/api/test/admin.test.ts`).
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.

## Owner decision

Q7: can editors publish, or only owners. Default if unanswered: owners and editors publish; viewers read.

**Built with the default:** owners and editors publish, viewers read (`ROLE_SCOPES` in `packages/tools/src/tool.ts`). Q7 is still open.

## What was built

- **`packages/tools`.** The registry, the dispatcher and the first eleven tools. `packages/tools/README.md` has the route contract for the CMS (M3-10), the tool list, and how to add a tool.
- **Routes.** `GET /api/tools` lists the tools the caller may use, with JSON Schema inputs. `POST /api/tools/:name` runs one (`apps/api/src/api/tools.ts`). Both run behind `requireOrg`, and the actor is the session user with client `cms`.
- **Tools.**
  - Screens: `list_screens`, `get_screen`, `rename_screen`, `update_screen_settings`, `revoke_screen_credential`.
  - Groups: `list_groups`, `create_group`, `rename_group`, `delete_group`, `set_group_members`.
  - Publishing: `publish_manifest_to_screen`.
- **Audit log.** Migration `0003_audit_client_id` adds `audit_log.client_id`. The dispatcher writes one row per successful change, recording:
  - actor kind and id;
  - client id;
  - action (the tool name);
  - target;
  - the input, with secrets redacted.

  Reads and refusals are not audited.
- **`packages/db`.** `screenGroups.setMembers` replaces a group's members in one batch, with the usual `NotInOrgError` checks.
- **`packages/player-core`.** `displayHoursProblems` and `validTimezone` are exported. `validateManifest` now calls `displayHoursProblems`, so the tool and the player check display hours the same way.
- **R2 keys** moved to `packages/tools/src/r2.ts`, because the publish tool reads them. `apps/api/src/r2.ts` re-exports them, so the device routes did not change.
- **Tests.**
  - `packages/tools/test/isolation.test.ts` is generated from the registry. It calls every tool as org B's owner, with org A's ids put into the tool's `example`, and expects `not_found`. A tool with no ids must succeed without leaking anything of org A's. An id field of a new kind fails until it is mapped. Afterwards, org A's data and audit log are checked unchanged.
  - `apps/api/test/routes.test.ts` is the guard. It enumerates the Worker's routes. Any route that is not a GET fails unless it is listed with a reason, and on `/api` only Better Auth and the tool route may be listed. It also calls every `/api` GET, and every read tool, on a D1 binding that records write statements, and fails if any of them writes to our tables. Finally, it checks that a change through the tool route writes `screens` and then `audit_log`. Adding a writing PATCH route or a GET that inserts was checked by hand: both make it fail.
  - `tenancy.test.ts` uses the real tools now. M3-09's test-only probe routes and the `extend` hook that mounted them are gone.

## Notes

- **`sf push` and `/admin`.** `sf push` still uploads through `/admin`, but `/admin` no longer sets the desired manifest itself. Its last step runs `publish_manifest_to_screen` through the dispatcher as the system actor `sf-push`: role owner, scope `content:publish` only, client `sf-push`. The publish is audited, and the CMS calls the same code. The direct `setDesiredManifest` call in `/admin` is retired. The client protocol did not change, so M3-05's use of `sf push` keeps working.
- **Why `sf push` does not call the tool with an API credential.** No such credential exists. `/api` refuses every `Authorization` header by design (M3-09), and the plan's agent credential is an OAuth grant on `/mcp` (Milestone 4). Inventing an API-key scheme now would add a fourth kind of caller to remove later. The upload routes stay because nothing else accepts blobs until M3-14. Blobs and stored manifests are content-addressed and inert until a publish names them.
- **What retires `/admin`.** Uploads through the CMS (M3-14) and OAuth grants (Milestone 4). With both, `sf push` can call the same tool on `/mcp`.
- **Minimum roles.** Every read is `viewer`. Every change is `editor`, except `revoke_screen_credential`, which is `owner`: revoking takes a screen off the air and cannot be undone without re-pairing. Groups and screen settings use `screens:manage`.
- **`delete_group`.** The schema would cascade the delete to schedule entries that target the group, so the tool refuses with 409 and lists those entries instead.
- **Audit write order.** D1 has no interactive transactions, so the audit row is written after the change. If that write fails, the request is a 500 and the change stands unrecorded.
- **CSRF.** The tool route takes `application/json` only (415 otherwise). A cross-site form cannot send that without a preflight, and the API never grants one.
- **Settings and the manifest.** `update_screen_settings` changes the screen row. Screens pick up the change with the next publish, once the server compiler (M3-13) builds manifests from these rows.
- **`/v1/device` writes.** The guard lists every route on that tree. When M3-07 adds `POST /v1/device/sync` (a screen reporting about itself), it must be added to `WRITERS` with its reason.

