# @signforge/tools

One registry of operations on an org's data. The CMS calls it over `/api/tools`. In Milestone 4 the MCP server and WebMCP call it too, as thin adapters. Nothing else on `/api` changes data, and `apps/api/test/routes.test.ts` fails if a route tries.

## For the CMS: the route

Both routes run behind `requireOrg`. They need a signed-in session with an active org, and refuse an `Authorization` header. The caller acts in the session's active org only. No field in the request can choose another org.

### `GET /api/tools`

Lists the tools the caller's role may use:

```json
{ "tools": [{ "name": "rename_screen", "description": "…", "scope": "screens:manage", "minRole": "editor",
              "mutates": true, "inputSchema": { "type": "object", … }, "outputSchema": { "type": "object", … },
              "example": { … } }] }
```

`inputSchema` and `outputSchema` are JSON Schema, generated from the tool's zod input and output. A viewer gets only the read tools. Use the list to hide the controls a user cannot use.

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
| 409 | `conflict` | The change would break something else, or (with `ifVersion`) the row changed since the caller read it. `details` says what. |
| 429 | `rate_limited` | Too many attempts (`claim_screen`); try again in a minute. |
| 401, 403 | `unauthenticated`, `no_active_organization`, `not_a_member` | Returned by `requireOrg`, before any tool runs. |

The CMS should keep every cookie a response sets (see M3-09). Times in outputs are milliseconds since the epoch.

## The tools

| Name | Scope | Min role | Input | Output |
| --- | --- | --- | --- | --- |
| `list_screens` | content:read | viewer | `{ limit?, cursor? }` | `{ screens: Screen[], next }`, by id |
| `list_screen_status` | content:read | viewer | `{ limit?, cursor? }` | `{ screens: { id, state, lastSeenAt, desiredManifestId, reportedManifestId }[], next }`, by id |
| `get_screen` | content:read | viewer | `{ screenId }` | `{ screen, groupIds, credentials, events }` |
| `rename_screen` | screens:manage | editor | `{ screenId, name, ifVersion? }` | `{ screen }` |
| `update_screen_settings` | screens:manage | editor | `{ screenId, timezone?, locale?, orientation?, displayHours?, ifVersion? }` | `{ screen }` |
| `set_display_override` | screens:manage | editor | `{ screenId, state: 'on' \| 'off' \| null }` | `{ screen }` |
| `identify_screen` | screens:manage | editor | `{ screenId }` | `{ screenId, seconds }` |
| `restart_screen` | screens:manage | editor | `{ screenId }` | `{ screenId }` |
| `revoke_screen_credential` | screens:manage | owner | `{ screenId, credentialId }` | `{ credential }` |
| `claim_screen` | screens:manage | editor | `{ code, name, timezone, orientation, locale?, displayHours?, idempotencyKey? }` | `{ screen }`; 404 for a code that is not open, 429 over the rate limit |
| `list_groups` | content:read | viewer | `{ limit?, cursor? }` | `{ groups: Group[], next }`, by id |
| `create_group` | screens:manage | editor | `{ name, screenIds?, idempotencyKey? }` | `{ group }` |
| `rename_group` | screens:manage | editor | `{ groupId, name, ifVersion? }` | `{ group }` |
| `delete_group` | screens:manage | editor | `{ groupId }` | `{ deleted }`, or 409 while a schedule entry targets the group |
| `set_group_members` | screens:manage | editor | `{ groupId, screenIds, ifVersion? }` | `{ group }` |
| `add_group_members` | screens:manage | editor | `{ groupId, screenIds }` | `{ group }` |
| `remove_group_members` | screens:manage | editor | `{ groupId, screenIds }` | `{ group }` |
| `publish_manifest_to_screen` | content:publish | editor | `{ screenId, manifestId }` | `{ screenId, manifestId, changed }` |
| `list_templates` | content:read | viewer | `{ status?, limit?, cursor? }` | `{ templates: Template[], next }`, base first, then by name |
| `get_template` | content:read | viewer | `{ templateId }` | `{ template }` |
| `register_template_version` | content:draft | editor | `{ manifest, bundleId, sourcesId }` | `{ template, version, changed }` |
| `set_template_version_status` | content:publish | owner | `{ templateVersionId, status }` | `{ version, changed }` |
| `list_assets` | content:read | viewer | `{ query?, status?, limit?, cursor? }` | `{ assets: (Asset & { usageCount })[], next }`, newest first |
| `get_asset` | content:read | viewer | `{ assetId }` | `{ asset, spotIds }` |
| `create_asset_upload` | content:draft | editor | `{ name, renditions: { landscape, portrait }, idempotencyKey? }` | `{ asset, uploads }` |
| `renew_asset_upload` | content:draft | editor | `{ assetId }` | `{ asset, uploads }` |
| `finalize_asset` | content:draft | editor | `{ assetId }` | `{ asset, changed }` |
| `create_video_upload` | content:draft | editor | `{ name, sha256, type: 'video/mp4', size, idempotencyKey? }` | `{ asset, upload: { uploadId, partBytes, parts, expiresAt } \| null }` |
| `finalize_video_upload` | content:draft | editor | `{ assetId, uploadId?, parts?: { partNumber, etag }[] }` | `{ asset, changed }` |
| `delete_asset` | content:draft | editor | `{ assetId }` | `{ deleted }`, or 409 while a spot uses the asset or a brand kit uses it as its logo |
| `list_fonts` | content:read | viewer | `{ limit?, cursor? }` | `{ fonts: Font[], next }`, by id |
| `list_brand_kits` | content:read | viewer | `{ limit?, cursor? }` | `{ brandKits: BrandKit[], next }`, by id |
| `get_brand_kit` | content:read | viewer | `{ brandKitId }` | `{ brandKit }` |
| `create_brand_kit` | content:draft | editor | `{ name, colors, shape?, displayFontId?, bodyFontId?, logoOnDarkAssetId?, logoOnLightAssetId?, makeDefault?, idempotencyKey? }` | `{ brandKit }` |
| `update_brand_kit` | content:draft | editor | `{ brandKitId, name?, colors?, shape?, displayFontId?, bodyFontId?, logoOnDarkAssetId?, logoOnLightAssetId?, ifVersion? }` | `{ brandKit }` |
| `set_default_brand_kit` | content:draft | editor | `{ brandKitId }` | `{ brandKit }` |
| `assign_brand_kit` | content:draft | editor | `{ brandKitId \| null, screenId? \| groupId? }` | `{ brandKit \| null }` |
| `list_data_sources` | content:read | viewer | `{ limit?, cursor? }` | `{ dataSources: DataSource[], next }`, by id |
| `get_data_source` | content:read | viewer | `{ dataSourceId }` | `{ dataSource, snapshot \| null }` |
| `create_data_source` | content:draft | editor | `{ id?, name, format, feedUrl, refreshS?, horizonDays?, idempotencyKey? }` | `{ dataSource }`; 409 past 10 per org |
| `update_data_source` | content:draft | editor | `{ dataSourceId, name?, feedUrl?, refreshS?, horizonDays? \| null, ifVersion? }` | `{ dataSource }` |
| `delete_data_source` | content:draft | editor | `{ dataSourceId }` | `{ deleted }`, or 409 while a spot binds it |
| `list_spots` | content:read | viewer | `{ limit?, cursor? }` | `{ spots: Spot[], next }`, most recently edited first |
| `get_spot` | content:read | viewer | `{ spotId }` | `{ spot }` |
| `create_spot` | content:draft | editor | `{ name, kind, durationMs?, templateVersionId?, data?, assets?, assetId?, fit?, url?, idempotencyKey? }` | `{ spot }` |
| `update_spot` | content:draft | editor | `{ spotId, name?, durationMs?, data?, assets?, assetId?, fit?, url?, ifVersion? }` | `{ spot }` |
| `get_spot_preview` | content:read | viewer | `{ orientation, templateVersionId?, brandKitId? }` | `{ preview, brandKitId, problems }` |
| `get_org_settings` | content:read | viewer | `{}` | `{ settings }` |
| `update_org_settings` | org:manage | owner | `{ timezone?, locale?, displayHours?, updateWindow?, unreachableAfterMinutes?, editorsPublish?, auditRetentionDays?, alerts?, ifVersion? }` | `{ settings }` |

Details:

- **Idempotency keys.** The creating tools (`create_group`, `create_asset_upload`, `create_video_upload`, `create_brand_kit`, `create_data_source`, `create_spot`, `claim_screen`) take an optional `idempotencyKey`: 8 to 128 printable ASCII characters the caller picks for one creation, such as a UUID. The CMS should send one with every create. A retry with the same key and input returns the first call's output and writes nothing, even when two calls race. The same key with a different input is refused with `conflict`. Keys are per org and kept about 7 days: a daily job deletes older ones (`expireIdempotencyKeys` in `packages/db`, from the API's five-minute Cron Trigger), after which a retry with the key creates again. A retried `create_asset_upload` returns the first call's upload URLs, which expire at their `expiresAt`. `register_template_version` needs no key: a version is registered once, and registering it again returns `changed: false`.
- **Conditional updates (`ifVersion`).** Screens, groups, brand kits, data sources, spots and org settings carry a `version` in their view: 1 when made (org settings: 1 until first set), moving on with every change through a tool (a group's also when its screens change; a screen's not with heartbeats or publishes, a data source's not with polls). Every update tool takes an optional `ifVersion`, the version the caller read. If the row has changed since, the call is refused with `conflict`, `details: { id, version }` (the version now), and nothing is written; read it again and redo the change. The check runs inside the batch that writes the change, so a change landing between the tool's read and its commit is caught too. Without `ifVersion` a change is made whatever the version. A save that makes several calls passes on the version each one returns. The CMS sends `ifVersion` with every edit of a screen and shows "This changed since you opened it" with a reload.
- **Group members.** `add_group_members` and `remove_group_members` change only the screens they name, so they cannot drop a screen someone else added; the CMS uses them. `set_group_members` replaces the whole list and should be given `ifVersion`.
- **Lists page.** Every `list_*` tool takes `limit` (default 50, at most 200) and `cursor`, and returns `next`. Pass `next` back as `cursor`, with the same filters, for the following page; `next` is `null` on the last page. A cursor is opaque. It holds the sort key of the last row returned, so rows added or removed between calls are neither repeated nor skipped. A cursor the server did not make is `invalid_input`. Most list tools read the org's whole list and cut the page (`page()`); `list_screen_status`, which the CMS polls, reads only its page in SQL (`keysetPage()`).
- **`update_screen_settings`.** Changes only the fields it is given. `null` clears `locale` (back to the player's default) or `displayHours` (always on). Display hours are checked by the contract's `displayHoursProblems`, the same check the player runs, so the CMS can show its messages as they are. A screen picks up a settings change with the next publish to it.
- **A screen's view** (`Screen` in every screen tool's output) adds what the CMS shows (`src/screen-state.ts`): `state` (`online`, `updating`, `asleep` with `wakesAt`, `unreachable`, or `needs_you` with a `reason`: `behind`, `revoked`, `nothing_published`, `fallback`), the last `heartbeat`, `showing` (what it should be showing now, worked out from its desired manifest with `player-core`: the playlist, its first spot, and an image hash for a thumbnail), and `displayOverride`. `status` is `revoked` once every credential the screen had is revoked (one that has not collected a credential yet is waiting, not revoked). A screen not heard from for the org's `unreachableAfterMinutes` (15 by default, `UNREACHABLE_AFTER_MS`) is unreachable; that is calm while it is on its desired manifest, because it keeps playing it, and `needs_you` / `behind` when it is not.
- **`list_screen_status`.** The fleet poll: each screen's `state`, `lastSeenAt` and manifests as `list_screens` gives them, and nothing else. It reads no settings and no manifests, and one page of screens in SQL over `(org_id, id)` (`screens.statusPage` in packages/db). For a page of `limit`, D1 reads `3 × (limit + 1)` rows for screens with one credential each (the screen, its credentials looked at twice for `revoked`, and one row past the page), plus the org's settings row once set: 10 rows for a page of 2, 64 for 20, whatever the org's size, and the same for a page after a cursor. A screen with revoked credentials, from a revoke or from pairing it again, reads about one more row for each. Through `/api/tools` the API also reads the member's row for the call (`requireOrg`). `list_screens` reads every screen and credential of the org on every page, and each uncached manifest. Measured in `test/screen-status.test.ts`.
- **`get_screen`.** Credentials come back without their hashes. `events` are the audit rows whose target is the screen, newest first, at most 20, each with the input the tool was given (secrets redacted).
- **`set_display_override`.** `on` or `off` lasts until the screen's next display-hours change, and at most 12 hours (`OVERRIDE_LIMIT_MS`, the only limit on a screen without display hours); `null` goes back to the hours. Stored on the screen (`display_override_json`), sent over the socket at once, and in every sync while the screen reports another override.
- **`identify_screen`, `restart_screen`.** Commands to a screen's socket (contract `DeviceCommand` `identify` and `restart`); a screen whose socket is down does not get them. They change nothing in the database, so they are marked `alwaysAudited`: audited, and their notices sent, though they stage no write.
- **`claim_screen`.** Pairs a screen (M3-08): `{ code, name, timezone, orientation, locale?, displayHours?, idempotencyKey? }` returns `{ screen }`. The code is as the screen shows it; case, spaces and dashes are ignored. An unknown, expired or already claimed code is `not_found`, one answer for all three. Every claim counts against the caller's rate limit (`Caller.rateLimit`, bucket `pairing_claim`: the API allows 10 a minute per member and per address) before the code is read, and over it is `rate_limited`; a caller with no `rateLimit` is refused, so no adapter can skip it. The screen collects its credential on its next poll. Two claims racing for one code: the second's batch fails and writes nothing (an error, not a refusal).
- **Brand kits.** Colours are hex. Leave out `onPrimary` or `onAccent` (or set it to `null` on update) to have it derived for 4.5:1 contrast; `derived` says which were. `warnings` lists pairs below 4.5:1; they do not stop a publish. Fonts are catalogue ids from `list_fonts` (`available: false` until the font's files are added; screens then draw with the template's font). A logo is a verified SVG or PNG image asset. The first kit becomes the default. A screen uses its own kit, else its groups', else the default: `reach` lists the screens a kit's edits will reach at the next publish, and `conflicts` the screens whose groups chose this kit and another (they cannot publish until the screen or a group is changed). Nothing reaches a screen until the next publish.
- **Spots.** Every spot tool works on the draft (packages/db, Drafts); a screen gets a spot only when a publish promotes it. A spot's view says whether it is `published` and whether its draft has changed since (`draftChanged`). `kind` is `template`, `image`, `video` or `url`, and each takes only its own fields: a template spot `templateVersionId` (fixed once made), `data` and `assets` (image fields to asset ids, each sent whole); an image or video spot a verified asset of that kind and a `fit`; a URL spot an https `url` (the contract's `safeUrl`). A template spot's data is checked as a screen would check it, with the compiler's `spotProblems` (the contract's `validateSpotData`, brand tokens and the template's duration range), and refused with `invalid_input`, one `details` entry per problem with `path` `data` or `durationMs`. An image field may stay empty in a draft until an asset is picked; the publish holds the draft back until then. Bindings to data sources are kept as they are; no tool sets them yet.
- **`get_spot_preview`.** What the CMS editor compiles a draft against in the browser, so the stage updates without a call per keystroke (docs/research/cms-data-layer.md, The 100 ms preview): the template version's manifest and bundle, the brand kit as a screen of that orientation would get it (`brandKitId`, else the org's default; built by the publish's own code in `src/publishing.ts`, `previewInput`), and the data sources. The editor adds a screen, the draft spot (asset ids turned into each asset's file for the orientation) and a one-spot playlist, and runs `compileScreen`. A kit that cannot be built is left out, with its problems.
- **Org settings (M3-42).** `src/settings.ts`. One `org_settings` row per org; every field reads as its default until an owner sets it: no default time zone or locale (`null`), always on (`displayHours: null`), update window 02:00 to 04:00, alert after 15 minutes, editors publish (`editorsPublish: true`), audit rows kept 365 days (`auditRetentionDays`), and alerts `screen_offline` and `publish_finished` to owners and editors, `agent_refused` to owners, each by email. `update_org_settings` changes only the fields given (`null` clears time zone, locale or hours; `alerts` sets the kinds given). The time zone, locale and hours are what the CMS's pairing form starts with; `unreachableAfterMinutes` (5 to 1440) is when a screen's state turns unreachable and when the API's alert check emails (`apps/api/src/alerts.ts`). `auditRetentionDays` (30 to 3,650: at least a month, so an owner cannot clear the record of what was just done; at most ten years, so the log stays bounded) is how long the org's audit rows are kept: the API's daily job deletes older ones (`expireAuditRows` in `packages/db`). Only `screen_offline` is sent today: publishing (M3-18) and agents (Milestone 4) will send the others.
- **`publish_manifest_to_screen`.** The manifest must already be stored for that screen. `sf push` stores manifests now; the server compiler will in M3-13.
- **Templates.** An org sees its own templates and the base ones (`owner: 'base'`). Each version carries its manifest, its status (`draft`, `approved`, `retired`) and the server's check report. Only approved versions should be offered for new spots.
- **`register_template_version`.** The bundle and sources (a JSON object of file name to text) must already be in R2 under the caller's prefix; `sf template push` uploads them through `/admin`. It runs `checkTemplateBundle` from the contract and refuses a failure with `invalid_input`, one `details` entry per problem, `path` naming the check (`manifest`, `forbidden-css`, `size`, `network`, `source-code`). The checks are a lint; the template sandbox is the guarantee. Versions are immutable: the same version with the same bundle and manifest returns `changed: false`, with different ones `conflict`. A new version is a draft.
- **`set_template_version_status`.** Owners only, and only the org's own versions; a base version is `not_found`. Retiring stops new spots using a version; spots already using it keep playing.

- **Uploading an image.** The browser does the scaling with `@signforge/media`, and `uploadImage` there runs these steps:
  1. **`create_asset_upload`.** The input names each rendition (`landscape`, `portrait`) with its `sha256`, `type` (JPEG, PNG, WebP or SVG), `size` in bytes (at most 20 MB), and `width` and `height` as displayed (`null` for SVG).
     - A raster rendition must be no larger than the cover rule allows for its screen box (`imageSizeProblem` in the contract): at least one side within 1920x1080, or 1080x1920 for portrait. It must also decode to at most `MAX_IMAGE_PIXELS` (3840x2160, about 8.3 million pixels), so a 65,535x1,080 strip, which has a side in the box, is still refused.
     - It creates the asset as `pending`, with both renditions, in one write. For each file the org does not already hold, it returns `{ sha256, method: 'PUT', url, headers, expiresAt }`. The URL is an R2 presigned PUT to `up/<org>/<asset>/<sha256>` that lasts 15 minutes. It signs the content type and length, so R2 refuses any other.
  2. **PUT** each file to its `url` with the `headers` given. URLs that have expired (a retry with the same `idempotencyKey` returns the first call's) are renewed with **`renew_asset_upload`**, which signs new ones for the same pending asset's files not yet PUT.
  3. **`finalize_asset`.** It refuses with `conflict`, changing nothing, unless the asset has both renditions. It reads each file back from R2, re-hashes it, checks the size, reads the type and pixel size from the bytes (`readImageInfo`), and checks the screen box and pixel cap again.
     - **All pass.** The files move to `o/<org>/b/<sha256>` and the asset becomes `verified`.
     - **Any fails.** Every upload for the asset is deleted, the asset becomes `rejected`, and the call is refused with `invalid_input`, one `details` entry per problem. That refusal is audited, because it changed the asset.
     - **A file not yet uploaded.** The call is refused and nothing changes.
     - **Called again on a verified asset.** It returns `changed: false`.
- **Uploading a video.** No transcoding: the file must already match the contract's `VIDEO_SPEC`. `uploadVideo` in `@signforge/media` checks it in the browser first (`@signforge/media-check`), then runs these steps:
  1. **`create_video_upload`.** The input is the file's `sha256`, `type` (`video/mp4`) and `size` (at most 500 MB). It creates the asset as `pending`, kind `video`, with no renditions: a screen of either orientation plays the one file. It starts an R2 multipart upload at `up/<org>/<asset>/<sha256>` and returns `{ uploadId, partBytes, parts, expiresAt }`: a presigned UploadPart URL for each 16 MiB part (the last is shorter), signed for its exact length, lasting an hour. `upload` is `null` when the org already holds the file.
  2. The browser PUTs each part and keeps the `ETag` header of each response. The bucket's CORS rule must expose `ETag`.
  3. **`finalize_video_upload`.** It takes `uploadId` and every part's ETag, parts 1 to N in order (it refuses a subset without changing anything, because R2 would complete one into a shorter file). It completes the upload, then reads the MP4 header over range reads and checks it (`checkVideo`), and re-hashes the whole file.
     - **All pass.** The file moves to `o/<org>/b/<sha256>` (R2 checks the hash again as it writes) and the asset becomes `verified`, with `width`, `height` and `durationMs` from the header.
     - **Any fails.** The upload is deleted, the asset becomes `rejected`, and the call is refused with `invalid_input`: one `details` entry per problem, `path` naming the check (`fps`, `profile`, `sha256`, ...), and the message ending with how to export a file that passes (`EXPORT_ADVICE`). Audited, as for images.
     - **Parts R2 cannot complete** (one missing, a wrong ETag), or nothing uploaded: refused, nothing changes; PUT again and retry.
  - `finalize_asset` and `renew_asset_upload` refuse a video, and `finalize_video_upload` an image, with `conflict`.
- **Assets.** An image asset's `sha256`, `type`, `size`, `width` and `height` are its landscape rendition's; a video's are its file's, and `durationMs` is its length (`null` for an image). `usageCount` and `spotIds` count spots that use the asset: image and video spots by `assetId`, template spots through their asset map. Only `verified` assets should be offered for spots.
- **`delete_asset`.** It refuses with `conflict` while a spot uses the asset, and `details.spotIds` lists the spots. A pending asset's uploads are deleted with it (a video's parts not yet completed are left to the bucket's lifecycle rule). Files in `o/<org>/b/` stay, because other assets or published manifests may name the same bytes; blob cleanup is M3-24.
- **Data sources.** A feed the server polls (`apps/api/src/data`) for spots to bind to. `format` is `json` (passed through), `ical` (a `CalendarFeed`) or `rss` (RSS 2.0 or Atom, a `NewsFeed`). `feedUrl` must be https on the default port and name a public host (`feedUrlProblem` in `@signforge/feeds`, the poller's own first check); it is sealed by `caller.feedUrls` (`FeedUrlSealer`; the API's is AES-GCM, bound to the org and source id) before it is stored, never returned, and redacted in the audit log. `refreshS` is 300 to 86,400 (default 300); `horizonDays` (1 to 366) is for calendars only. A new or changed URL is polled within a minute. `failures` and `lastError` (a category) show a feed the poller is backing off from. `get_data_source` returns the latest snapshot as screens get it, for the editor's preview. `delete_data_source` refuses with `conflict` while a spot's draft or published version binds the source (`details.spotIds`).
- **Upload configuration.** The dispatcher passes `caller.uploads`, an `UploadSigner` (`r2Presigner` in `src/upload.ts`), to the handlers. `/api/tools` builds it from the Worker's settings (`apps/api/src/uploads.ts`). Without one, `create_asset_upload` and `create_video_upload` fail with a 500.

Each tool's `description` is written for an agent choosing a tool, its `output` is the zod schema of what it returns, and its `example` is a valid input.

## Roles and scopes

- **Scopes.** They are `content:read`, `content:draft`, `content:publish`, `screens:manage` and `org:manage` (the org's settings).
- **Sessions.** A session holds every scope its role allows.
- **Agent grants (Milestone 4).** A grant names its own scopes, and they are capped by the user's role.

| Role | Scopes |
| --- | --- |
| owner | all |
| editor | all but `org:manage`; `content:publish` only while the org's `editorsPublish` is on |
| viewer | `content:read` |

Owner decision Q7 (can editors publish?), decided 2026-11-18: an owner chooses, per org (`editorsPublish` in the org's settings, on until changed). The dispatcher reads it on every call (`grantOf` in `src/dispatch.ts`), so a change applies from the next call. With it off, an editor keeps `content:read`, `content:draft` and `screens:manage`; an agent's grant is capped by the role in the same way, so an editor's agent cannot publish either. A publish refused for this reason is `forbidden` with the message "Only owners publish in this organization", and `GET /api/tools` leaves the publish tools out of the editor's list, so the CMS's command menu does not offer them. Separately, each tool sets a minimum role. Revoking a screen credential and changing the org's settings are for owners only. Members, roles and invitations are Better Auth's endpoints, not tools; its organization plugin lets only owners change them (`apps/api/src/auth/roles.ts`, tested in `apps/api/test/members.test.ts`).

## The dispatcher

`dispatch(registry, name, input, caller)` (`src/dispatch.ts`) runs these steps in order:

1. Finds the tool.
2. Checks the role and scopes.
3. Validates the input.
4. For a keyed creation, returns the first result if the key was used before (see Idempotency keys above).
5. Runs the handler with `{ org: scoped(db, orgId), actor, input, blobs, uploads, write, notify }`.
   A handler reads through `ctx.org` but never writes: it stages each change with `ctx.write(org.<repo>.stage.<op>(...))`, which returns the row as it will be (see `packages/db`'s README).
   In tests it then parses the output with the tool's output schema and throws on a mismatch, before anything is written (`setOutputChecks(true)`, called by `test/setup.ts` here and in `apps/api`). Production skips the parse.
   A handler that changes something a screen should hear of at once queues it with `ctx.notify((screens) => screens.manifest(...) | screens.revoked(...) | screens.command(...))`. The notices go out after step 6, only if the commit succeeded, through the caller's `screens` (`ScreenNotifier`; the API's reaches each screen's Durable Object). A notice that fails is logged, not returned: the screen catches up at its next sync.
6. Commits the staged writes in one D1 `batch()`, together with an `audit_log` row and, for a keyed creation, its idempotency record. The batch is atomic: if the audit row cannot be written, the change is not made either, and the request fails. The audit row holds:
   - actor kind and id;
   - client id (`cms`, `sf-push`, or an agent's OAuth client);
   - action (the tool name);
   - target;
   - `detail_json` holding the input, with secret-looking fields redacted (`redact()`).

A call that staged nothing changed nothing, and writes nothing: no audit row either (publishing the current manifest again, revoking a revoked credential). The exception is a tool marked `alwaysAudited`, whose effect is a command to a screen (`identify_screen`, `restart_screen`): it is audited every time. This is deliberate (decided 2026-11-17): the audit log answers "what changed, and who changed it"; an agent retrying a call, or a person publishing twice, would otherwise fill it with rows that describe nothing. Reads are not audited. A refusal (`ToolError`) or any other error discards what was staged, except a refusal that changed something on the way: a handler marks one with `new ToolError(code, message, details, true)`, and what it staged is committed, audited with `refused: { error, message }` in its detail. So far only `finalize_asset` does this, when it rejects an upload. Files in R2 are not part of the batch: `finalize_asset` moves or deletes uploads before its batch, so a failed batch can leave a verified file in place (harmless; finalize finds it again) or a rejected upload deleted with its asset still pending (finalize then reports it not uploaded).

### The platform registry

`platformRegistry` holds `register_template_version` and `set_template_version_status` again, dispatched with `platform(db)` (from `@signforge/db`) instead of an org's scope, so they write base templates. Its changes are audited in `platform_audit_log`, because they belong to no org. Only `/admin` uses it. It is never served on `/api`, so no org member can change a base template. A tool works on both scopes when it is declared with `defineSharedTool` and reaches data only through what both scopes share (`templates`, `auditLog`, `commit`, `orgId`, which is null on the platform's).

Callers so far:

- `/api/tools`: actor `user` with the session's user id, client `cms`, and a `rateLimit` on the `PAIR_CLAIM_LIMIT` binding keyed by user and by address.
- `/admin`'s manifest upload: actor `system` with id `sf-push`, role owner, scope `content:publish` only.
- `/admin`'s template registration (`sf template push`): actor `system` with id `sf-push`, role owner, scopes `content:draft` and `content:publish`; the platform registry for base templates, the org registry for an org's.

## Publishing: drafts and the loader

`src/publishing.ts` is what M3-18's publish tool builds on. Spots, playlists and schedule entries each have a draft (the row) and a published version (see `packages/db`'s README); edits change the draft only.

- `loadOrg(org)` reads everything a publish needs: the org's settings, with its publish revision, first, then the rest in one round of parallel queries. Reading the revision before any content is what lets the publish order guard cover all of it, and playlist versions before their items what lets each playlist's guard cover its items.
- `promoteDrafts(org, graph, opts)` checks each draft that differs from its published version, in order: spots, then playlists (every item must be a published spot), then schedule entries (their playlist must be published). A draft is checked by compiling a probe screen that plays it, for each orientation the org's screens have, so its problems are exactly the ones a screen would get. A spot may use only an approved template version, or keep a retired one it was already published with. A draft that passes is staged for publishing; one that fails keeps its published version, if any, and is reported in `held`. It never blocks the rest.
- `compileInputFor(graph, screenId)` and `loadCompileInput(org, screenId)` give a screen's published graph as `compileScreen` takes it: image files are the asset's rendition for the screen's orientation, a video is the asset's own file, a template bundle's size comes from its stored check report.
- `publishOrg(org, { hash, now })` promotes drafts and compiles every screen. A screen that cannot compile is reported with its problems and keeps its manifest; the others publish. With no default playlist set, no screen can. It stages writes and returns them; the caller commits them in one batch with its publish row (`publishes.stage.insert`), its rollout rows (`publishes.stage.addScreens`) and its switch of each screen's desired manifest (`screens.stage.setDesiredManifest`). The writes start with the publish's place in the org's order (`publishes.stage.advance`, from the revision `loadOrg` read), and each promotion is guarded by its draft's version. So if another publish committed after this one read, or a draft it promotes was edited since, the batch fails with `StaleVersionError` (the dispatcher's `conflict`) and nothing is written or switched: an older publish never replaces newer content on a screen. Load and compile again to retry.

`test/publishing.test.ts` checks that the loader and compiler produce `sf build`'s manifest for `examples/stress` (its golden).

## Adding a tool

1. Write it with `defineTool` next to its kind (`src/screens.ts`, `src/groups.ts`, …).
   - Name it in snake_case.
   - Write the description for an agent.
   - Give it the narrowest scope and role.
   - Set `mutates: true` if it changes anything.
   - Give a `target` for the audit log.
   - Give an `output` schema: what it returns, as zod. The handler's return type is checked against it at compile time, and every output against it in tests.
   - A `list_*` tool pages: spread `pageInput` (`src/paging.ts`) into its input, add `next: nextOutput` to its output, and cut the rows with `page()`.
   - Give an `example`.
2. Name id fields after their kind, such as `screenId` or `playlistIds`.
3. Reach data only through `ctx.org`, and write only by staging: `ctx.write(ctx.org.<repo>.stage.<op>(...))`. A creating tool sets `idempotent: true` and adds `idempotencyKey` (`src/fields.ts`) to its input. A missing row is `throw notFound(...)`, and a repository's `NotInOrgError` maps to `not_found` on its own.
4. An update tool (one that changes a row a person or agent edits: named `update_<thing>` or `rename_<thing>`, or `set_<thing>_members` for one that replaces a list) is conditional:
   - Give the row a version: a `row_version` column (`rowVersion()` in `packages/db/src/schema.ts`, with a migration). The repositories move it on with every `stage.update` and `stage.touch`.
   - Put `version` (`src/fields.ts`) in the row's view, set from `row.rowVersion`.
   - Add `ifVersion` (`src/fields.ts`) to the input, and pass it to the repository: `ctx.write(org.<repo>.stage.update(row, patch, input.ifVersion))`. For a change to what belongs to a row (a group's members), `stage.touch(row, input.ifVersion)` moves the row's version on, guarded the same way.
   - That is all. The repository refuses a stale version before staging, and again inside the batch; the dispatcher turns either into `conflict` with `{ id, version }`. The tool does not compare versions itself.
   - A tool that replaces a whole list also gets add and remove forms (`add_group_members`, `remove_group_members`), which need no version.
5. Add it to `TOOLS` in `src/registry.ts`.

`test/isolation.test.ts` then calls it as org B's owner once for each id field in its input schema, optional ones and those of one branch included: org A's id in that field, org B's own rows in the rest. It expects `not_found` naming A's id. A tool with no id fields must succeed without returning anything of org A's. An id field of a new kind fails that test until you map it in `ORG_IDS`; a field it cannot reach with a valid input fails until the tool's example reaches it, or, for a field only another kind of spot has, until `REACHED_BY` gives the input that does.

## Tests

- `test/isolation.test.ts`: generated from the registry, as above.
- `test/conventions.test.ts`: fails on a tool without an output schema, a `list_*` tool without paging, or an update tool without `ifVersion` in its input and `version` in its output, and checks the output check and paging itself.
- `test/versions.test.ts`: a stale `ifVersion` is refused and writes nothing, even when the change lands between the read and the commit; group members added and removed without dropping anyone's.
- `test/write-guard.test.ts`: generated from the registry. It runs every tool that changes data on a D1 that records any write sent outside `batch()`, and fails if there is one. A tool whose example refuses before writing is set up to get further in `PREPARE`.
- `test/screen-status.test.ts`: `list_screen_status` gives the states `list_screens` does, reads no manifest, and reads one page's rows from D1 (counted from D1's own `rows_read`) however many screens the org has.
- `test/dispatch.test.ts`: role and scope checks, validation, the audit log and redaction, a failing audit row rolling the change back, and idempotency keys.
- `test/tools.test.ts`, `test/templates.test.ts`, `test/assets.test.ts`, `test/videos.test.ts`: what each tool does. The video tests upload media-check's ffmpeg-made clips, passed in by `vitest.config.ts`.

They run in workerd against local D1, with `packages/db`'s migrations applied, and local R2.

`test/e2e/upload.test.ts` runs in Node (`vitest.e2e.config.ts`), as part of `pnpm test`. It drives Chromium (Playwright's, or `SF_CHROMIUM`) and a Miniflare Worker (`test/harness-worker.ts`). That Worker runs the dispatcher and serves the bucket's S3 API, which checks presigned signatures. The test:

- uploads a 4K photo with an EXIF rotation through `@signforge/media` and these tools;
- forges an upload, which is refused and removed;
- sends PUTs of the wrong size, type or key, which R2 refuses;
- uploads a video in two presigned parts through `uploadVideo`, has a 60 fps video refused in the browser before any call, and has the same video, PUT past the browser check, rejected by `finalize_video_upload`;
- tries to delete an asset in use, which is refused.
