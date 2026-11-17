# M3-14 Assets: upload and library

Status: in progress: upload done, library page waits for the CMS design (branch `t3/m3-14-asset-upload`)  ·  Size: M  ·  Depends on: M3-12

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
- [ ] Asset library page: grid, search by name, usage count, delete when unused. Waits for the CMS design; the tools it needs are done.
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
