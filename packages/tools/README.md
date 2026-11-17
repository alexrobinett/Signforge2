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
| `list_templates` | content:read | viewer | `{ status? }` | `{ templates: Template[] }`, base first |
| `get_template` | content:read | viewer | `{ templateId }` | `{ template }` |
| `register_template_version` | content:draft | editor | `{ manifest, bundleId, sourcesId }` | `{ template, version, changed }` |
| `set_template_version_status` | content:publish | owner | `{ templateVersionId, status }` | `{ version, changed }` |
| `list_assets` | content:read | viewer | `{ query?, status? }` | `{ assets: (Asset & { usageCount })[] }`, newest first |
| `get_asset` | content:read | viewer | `{ assetId }` | `{ asset, spotIds }` |
| `create_asset_upload` | content:draft | editor | `{ name, renditions: { landscape, portrait } }` | `{ asset, uploads }` |
| `finalize_asset` | content:draft | editor | `{ assetId }` | `{ asset, changed }` |
| `delete_asset` | content:draft | editor | `{ assetId }` | `{ deleted }`, or 409 while a spot uses the asset |

Details:

- **`update_screen_settings`.** Changes only the fields it is given. `null` clears `locale` (back to the player's default) or `displayHours` (always on). Display hours are checked by player-core's `displayHoursProblems`, the same check the player runs, so the CMS can show its messages as they are. A screen picks up a settings change with the next publish to it.
- **`get_screen`.** Credentials come back without their hashes.
- **`publish_manifest_to_screen`.** The manifest must already be stored for that screen. `sf push` stores manifests now; the server compiler will in M3-13.
- **Templates.** An org sees its own templates and the base ones (`owner: 'base'`). Each version carries its manifest, its status (`draft`, `approved`, `retired`) and the server's check report. Only approved versions should be offered for new spots.
- **`register_template_version`.** The bundle and sources (a JSON object of file name to text) must already be in R2 under the caller's prefix; `sf template push` uploads them through `/admin`. It runs `checkTemplateBundle` from the contract and refuses a failure with `invalid_input`, one `details` entry per problem, `path` naming the check (`manifest`, `forbidden-css`, `size`, `network`, `source-code`). The checks are a lint; the template sandbox is the guarantee. Versions are immutable: the same version with the same bundle and manifest returns `changed: false`, with different ones `conflict`. A new version is a draft.
- **`set_template_version_status`.** Owners only, and only the org's own versions; a base version is `not_found`. Retiring stops new spots using a version; spots already using it keep playing.

- **Uploading an image.** The browser does the scaling with `@signforge/media`, and `uploadImage` there runs these steps:
  1. **`create_asset_upload`.** The input names each rendition (`landscape`, `portrait`) with its `sha256`, `type` (JPEG, PNG, WebP or SVG), `size` in bytes (at most 20 MB), and `width` and `height` as displayed (`null` for SVG).
     - A raster rendition must be no larger than the cover rule allows for its screen box (`fitsScreenBox` in the contract): at least one side within 1920x1080, or 1080x1920 for portrait.
     - It creates the asset as `pending`. For each file the org does not already hold, it returns `{ sha256, method: 'PUT', url, headers, expiresAt }`. The URL is an R2 presigned PUT to `up/<org>/<asset>/<sha256>` that lasts 15 minutes. It signs the content type and length, so R2 refuses any other.
  2. **PUT** each file to its `url` with the `headers` given.
  3. **`finalize_asset`.** It reads each file back from R2, re-hashes it, checks the size, reads the type and pixel size from the bytes (`readImageInfo`), and checks the screen box again.
     - **All pass.** The files move to `o/<org>/b/<sha256>` and the asset becomes `verified`.
     - **Any fails.** Every upload for the asset is deleted, the asset becomes `rejected`, and the call is refused with `invalid_input`, one `details` entry per problem. That refusal is audited, because it changed the asset.
     - **A file not yet uploaded.** The call is refused and nothing changes.
     - **Called again on a verified asset.** It returns `changed: false`.
- **Assets.** An asset's `sha256`, `type`, `size`, `width` and `height` are its landscape rendition's. `usageCount` and `spotIds` count spots that use the asset: image and video spots by `assetId`, template spots through their asset map. Only `verified` assets should be offered for spots.
- **`delete_asset`.** It refuses with `conflict` while a spot uses the asset, and `details.spotIds` lists the spots. A pending asset's uploads are deleted with it. Files in `o/<org>/b/` stay, because other assets or published manifests may name the same bytes; blob cleanup is M3-24.
- **Upload configuration.** The dispatcher passes `caller.uploads`, an `UploadSigner` (`r2Presigner` in `src/upload.ts`), to the handlers. `/api/tools` builds it from the Worker's settings (`apps/api/src/uploads.ts`). Without one, `create_asset_upload` fails with a 500.

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
4. Runs the handler with `{ org: scoped(db, orgId), actor, input, blobs, uploads }`.
5. For a tool that changes data, appends to `audit_log`:
   - actor kind and id;
   - client id (`cms`, `sf-push`, or an agent's OAuth client);
   - action (the tool name);
   - target;
   - `detail_json` holding the input, with secret-looking fields redacted (`redact()`).

Reads are not audited, and neither are refusals, except a refusal that changed something on the way. A handler marks one with `new ToolError(code, message, details, true)`, and it is audited with `refused: { error, message }` in its detail. So far only `finalize_asset` does this, when it rejects an upload. D1 has no interactive transactions, so the audit row is written after the change. If that write fails, the request fails, and the change stands without an audit row.

### The platform registry

`platformRegistry` holds `register_template_version` and `set_template_version_status` again, dispatched with `platform(db)` (from `@signforge/db`) instead of an org's scope, so they write base templates. Its changes are audited in `platform_audit_log`, because they belong to no org. Only `/admin` uses it. It is never served on `/api`, so no org member can change a base template. A tool works on both scopes when it is declared with `defineSharedTool` and reaches data only through what both scopes share (`templates`, `auditLog`, `orgId`, which is null on the platform's).

Callers so far:

- `/api/tools`: actor `user` with the session's user id, client `cms`.
- `/admin`'s manifest upload: actor `system` with id `sf-push`, role owner, scope `content:publish` only.
- `/admin`'s template registration (`sf template push`): actor `system` with id `sf-push`, role owner, scopes `content:draft` and `content:publish`; the platform registry for base templates, the org registry for an org's.

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
- `test/tools.test.ts`, `test/templates.test.ts`, `test/assets.test.ts`: what each tool does.

They run in workerd against local D1, with `packages/db`'s migrations applied, and local R2.

`test/e2e/upload.test.ts` runs in Node (`vitest.e2e.config.ts`), as part of `pnpm test`. It drives Chromium (Playwright's, or `SF_CHROMIUM`) and a Miniflare Worker (`test/harness-worker.ts`). That Worker runs the dispatcher and serves the bucket's S3 API, which checks presigned signatures. The test:

- uploads a 4K photo with an EXIF rotation through `@signforge/media` and these tools;
- forges an upload, which is refused and removed;
- sends PUTs of the wrong size, type or key, which R2 refuses;
- tries to delete an asset in use, which is refused.
