# @signforge/tools

One registry of operations on an org's data. The CMS calls it over `/api/tools`. In Milestone 4 the MCP server and WebMCP call it too, as thin adapters. Nothing else on `/api` changes data, and `apps/api/test/routes.test.ts` fails if a route tries.

## For the CMS: the route

Both routes run behind `requireOrg`. They need a signed-in session with an active org, and refuse an `Authorization` header. The caller acts in the session's active org only. No field in the request can choose another org.

### `GET /api/tools`

Lists the tools the caller's role may use:

```json
{ "tools": [{ "name": "rename_screen", "description": "…", "scope": "screens:manage", "minRole": "editor",
              "mutates": true, "inputSchema": { "type": "object", … }, "example": { … } }] }
```

`inputSchema` is JSON Schema, generated from the zod input. A viewer gets only the read tools. Use the list to hide the controls a user cannot use.

### `POST /api/tools/:name`

- **Request.** The body is the tool's input as JSON, sent with `content-type: application/json`. Any other content type gets 415. An empty body counts as `{}`.
- **Success.** 200, and the body is the tool's output as JSON.
- **Refusal.** The body is `{ "error": code, "message": text, "details"?: … }`:

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_input` | The input fails the schema. `details` is `[{ path, message }]`, one entry per field. |
| 403 | `forbidden` | The caller's role or scopes do not allow the tool. |
| 404 | `unknown_tool` | No tool has that name. |
| 404 | `not_found` | An id names nothing in this org, including another org's ids. |
| 409 | `conflict` | The change would break something else. `details` says what. |
| 401, 403 | `unauthenticated`, `no_active_organization`, `not_a_member` | Returned by `requireOrg`, before any tool runs. |

The CMS should keep every cookie a response sets (see M3-09). Times in outputs are milliseconds since the epoch.

## The tools

| Name | Scope | Min role | Input | Output |
| --- | --- | --- | --- | --- |
| `list_screens` | content:read | viewer | `{}` | `{ screens: Screen[] }` |
| `get_screen` | content:read | viewer | `{ screenId }` | `{ screen, groupIds, credentials }` |
| `rename_screen` | screens:manage | editor | `{ screenId, name }` | `{ screen }` |
| `update_screen_settings` | screens:manage | editor | `{ screenId, timezone?, locale?, orientation?, displayHours? }` | `{ screen }` |
| `revoke_screen_credential` | screens:manage | owner | `{ screenId, credentialId }` | `{ credential }` |
| `list_groups` | content:read | viewer | `{}` | `{ groups: Group[] }` |
| `create_group` | screens:manage | editor | `{ name, screenIds? }` | `{ group }` |
| `rename_group` | screens:manage | editor | `{ groupId, name }` | `{ group }` |
| `delete_group` | screens:manage | editor | `{ groupId }` | `{ deleted }`, or 409 while a schedule entry targets the group |
| `set_group_members` | screens:manage | editor | `{ groupId, screenIds }` | `{ group }` |
| `publish_manifest_to_screen` | content:publish | editor | `{ screenId, manifestId }` | `{ screenId, manifestId, changed }` |

Details:

- **`update_screen_settings`.** Changes only the fields it is given. `null` clears `locale` (back to the player's default) or `displayHours` (always on). Display hours are checked by player-core's `displayHoursProblems`, the same check the player runs, so the CMS can show its messages as they are. A screen picks up a settings change with the next publish to it.
- **`get_screen`.** Credentials come back without their hashes.
- **`publish_manifest_to_screen`.** The manifest must already be stored for that screen. `sf push` stores manifests now; the server compiler will in M3-13.

Each tool's `description` is written for an agent choosing a tool, and its `example` is a valid input.

## Roles and scopes

- **Scopes.** They are `content:read`, `content:draft`, `content:publish` and `screens:manage`.
- **Sessions.** A session holds every scope its role allows.
- **Agent grants (Milestone 4).** A grant names its own scopes, and they are capped by the user's role.

| Role | Scopes |
| --- | --- |
| owner | all |
| editor | all |
| viewer | `content:read` |

Owner decision Q7 (can editors publish?) is still open. The table shows the default: owners and editors publish, and viewers only read. Changing the answer means editing `ROLE_SCOPES` in `src/tool.ts`. Separately, each tool sets a minimum role. Revoking a screen credential is for owners only.

## The dispatcher

`dispatch(registry, name, input, caller)` (`src/dispatch.ts`) runs these steps in order:

1. Finds the tool.
2. Checks the role and scopes.
3. Validates the input.
4. Runs the handler with `{ org: scoped(db, orgId), actor, input, blobs }`.
5. For a tool that changes data, appends to `audit_log`:
   - actor kind and id;
   - client id (`cms`, `sf-push`, or an agent's OAuth client);
   - action (the tool name);
   - target;
   - `detail_json` holding the input, with secret-looking fields redacted (`redact()`).

Reads are not audited, and neither are refusals. D1 has no interactive transactions, so the audit row is written after the change. If that write fails, the request fails, and the change stands without an audit row.

Callers so far:

- `/api/tools`: actor `user` with the session's user id, client `cms`.
- `/admin`'s manifest upload: actor `system` with id `sf-push`, role owner, scope `content:publish` only.

## Adding a tool

1. Write it with `defineTool` next to its kind (`src/screens.ts`, `src/groups.ts`, …).
   - Name it in snake_case.
   - Write the description for an agent.
   - Give it the narrowest scope and role.
   - Set `mutates: true` if it changes anything.
   - Give a `target` for the audit log.
   - Give an `example`.
2. Name id fields after their kind, such as `screenId` or `playlistIds`.
3. Reach data only through `ctx.org`. A missing row is `throw notFound(...)`, and a repository's `NotInOrgError` maps to `not_found` on its own.
4. Add it to `TOOLS` in `src/registry.ts`.

`test/isolation.test.ts` then calls it as org B's owner, with org A's ids put into its example, and expects `not_found`. A tool with no id fields must succeed without returning anything of org A's. An id field of a new kind fails that test until you map it in `ORG_A_IDS`.

## Tests

- `test/isolation.test.ts`: generated from the registry, as above.
- `test/dispatch.test.ts`: role and scope checks, validation, the audit log and redaction.
- `test/tools.test.ts`: what each tool does.

They run in workerd against local D1, with `packages/db`'s migrations applied, and local R2.
