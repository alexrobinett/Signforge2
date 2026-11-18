# M3-14 Assets: upload and library

Status: done (upload: branch `t3/m3-14-asset-upload`; library page: branch `m3-14-asset-library`)  ·  Size: M  ·  Depends on: M3-12

## Goal

Upload images straight to R2, scaled in the browser, verified on the server.

## Read first

- docs/backend-plan.md#publishing (uploads)
- packages/cli/src/sf.ts (`fitImage`: the cover rule)

## Scope

- Presigned R2 PUT; a finalize tool re-hashes and marks the asset verified.
- Browser scaling with `createImageBitmap` and `OffscreenCanvas` into landscape and portrait renditions using the same rule as `fitImage`; EXIF orientation honoured.
- The Worker checks image dimensions and type; rejects oversize.
- Asset library page: grid, search by name, usage count, delete when unused.

## Out of scope

- Video (M3-21).

## Done when

- [x] A 4K phone photo uploads as renditions no larger than the screen box (`packages/tools/test/e2e/upload.test.ts` and `packages/media/test/renditions.test.ts`, real Chromium).
- [x] A file whose bytes do not match its claimed hash is rejected (same test, and `packages/tools/test/assets.test.ts`).
- [x] Asset library page: grid, search by name, usage count, delete when unused (`apps/cms/e2e/assets.spec.ts`: uploads a 4K phone photo and a logo through `uploadImage`, refuses a file that is not an image, searches by name, shows "Used by 1 spot" for a photo a spot uses and offers no delete for it, deletes the unused logo; the words in `apps/cms/test/assets.test.ts`).
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.

## Notes

Upload half, done before the library page (which waits for the CMS design).

- **Code.**
  - `packages/media`: browser renditions, SHA-256 and `uploadImage`, plus `readImageInfo`, the image-header reader that also runs in the Worker.
  - `packages/tools/src/assets.ts`: `list_assets`, `get_asset`, `create_asset_upload`, `finalize_asset`, `delete_asset`.
  - `packages/tools/src/upload.ts`: the SigV4 presigner.
  - `apps/api/src/uploads.ts`: the API's presigner settings.
  - Tests: `packages/media/test/` (header reader; renditions in Chromium) and `packages/tools/test/assets.test.ts` (tool behaviour in workerd).
  - `packages/tools/test/e2e/upload.test.ts`: the whole flow in Chromium against a Miniflare Worker with its S3 API. It lives in tools because `tools` depends on `media`.
  - `org.assets.usage()` in `packages/db`.
- **Contract.** `SCREEN_BOX` moved out of `sf.ts`, joined by `coverSize` (fitImage's rule, which `sf build` now calls) and `fitsScreenBox`. This was its own commit; `sf build` output is unchanged (golden test).
- **Transport: presigned PUT.**
  - Wrangler and Miniflare serve the local bucket's S3 API at `/cdn-cgi/local/r2/s3/<bucket>` when the binding has `local_dev.experimental_s3_credentials`, and they check SigV4 as R2 does. `apps/api/wrangler.jsonc` sets local-only credentials.
  - Checked by hand against `wrangler dev` on 2026-11-17: a signed PUT got 200 and the object was readable with `wrangler r2 object get --local`. A longer body, another content type and another key each got 403. The e2e test repeats this in Miniflare on every run.
  - Not verified on the account, because R2 is not enabled there (M3-00).
  - Deploying needs four things:
    - `R2_S3_ENDPOINT` and `R2_BUCKET_NAME` vars.
    - `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` secrets, from an R2 API token limited to the bucket.
    - A bucket CORS rule allowing PUT with `content-type` from the CMS origin.
    - A lifecycle rule expiring `up/` after a day.

    Without the settings outside dev, `create_asset_upload` fails with a 500. No Worker upload route was needed, so the route guard is unchanged.
- **Judgement calls.**
  - **Uploads go to `up/<org>/<asset>/<sha256>`, not straight to `o/<org>/b/<sha256>`.** A forged PUT to a content-addressed key could overwrite bytes a live manifest serves. Finalize moves a file there only after checking it.
  - **The signature binds type and length, not content.** R2's presigned PUT cannot bind a SHA-256 the way we need, so finalize re-hashes. The size cap is enforced twice: by the signed length and in the schema, at 20 MB per rendition.
  - **"No larger than the screen box" means the cover rule.** At least one side is within the box (`fitsScreenBox`). A cover-scaled portrait rendition of a landscape photo is wider than 1080 by design (3413x1920 for 4K).
  - **Output types.** A JPEG is encoded as JPEG. Everything else raster is encoded as WebP, which keeps alpha. A JPEG, PNG or WebP that needs no scaling and no rotation ships unchanged, as `sf build` does. SVG passes through for both orientations.
  - **A failed finalize marks the asset `rejected` and deletes its uploads.** Changing data on a refusal needed the dispatcher to audit refusals: `ToolError`'s new `changed` flag. A file not yet uploaded is refused without changing anything, so the client can retry.
  - **The asset row's sha, type, size and pixel size are its landscape rendition's.** The original file never reaches the server, so it cannot be verified.
  - **SVG renditions store width and height as 0.** The columns are NOT NULL; tools return `null`. This avoided a migration.
  - **`delete_asset` keeps `o/<org>/b/` files.** Other assets and published manifests may name the same bytes; blob cleanup is M3-24.

Library page, done after the CMS design (M3-11's tokens, components and store).

- **Code.**
  - `apps/cms/src/routes/_app/assets.tsx`: the page. A tile wall in the Screens page's language (the canvas has no library board; the kit and the Screens tiles set the look), search in `?q=`, a summary line ("3 images · 1 in use"), upload, and delete behind the kit's dialog for what cannot be undone.
  - `apps/cms/src/components/assets/`: the tile (`AssetCard`), the search box, `UploadButton` and `UploadProgress`, and `AssetPicker`, the library in a dialog for the spot editor. It takes the assets from the host route's loader, offers verified images only, and a click picks.
  - `apps/cms/src/state/assets.ts`: the uploads in progress, the delete being confirmed, the picker's search. `apps/cms/src/server/assets.functions.ts` reads `list_assets` (every page).
  - `apps/cms/src/lib/assets.ts`: the tool's output type and the words (facts, usage, summary, name match).
- **Dev uploads from the CMS.** A tool call the CMS hands over its service binding carries the CMS's origin, so the dev presigner signed URLs for a host that does not serve the API's bucket. `LOCAL_S3_ORIGIN` (dev only) names the API's own origin; `pnpm --filter @signforge/api dev` and the CMS e2e set it. The local S3 API answers CORS preflights with `*`, so the cross-origin PUT works. Deployed, the bucket's CORS rule (above) does this job.
- **Judgement calls.**
  - **Uploads go one file at a time.** Two 4K photos decoded at once is a lot of memory on a phone.
  - **A tile shows the landscape rendition, cropped to 16:9**, the frame most screens are; an SVG is shown whole.
  - **Usage counts spots only** (`org.assets.usage()`). A brand kit's logo shows "Not used" and offers delete; the server refuses it with its message ("is the logo of 1 brand kit"), shown in the dialog.
  - **`AssetPicker` has no user yet**, so knip.jsonc lists it as an entry. M3-16 drops that entry when its image field opens it.
- **Focal point: left for M3-16** (M3-25 deferred it here). It changes what a screen sees, so it needs the contract, a column, a tool, the compiler, the player and SDK, every image template and a Pi measurement, and the only place a person can judge a crop is the spot editor's stage. What it needs is in M3-16's notes.
- **Out of scope here: video** (M3-21 adds video tiles and upload).
