# @signforge/media

Images and videos for screens, prepared in the browser before upload. The CMS's asset library uses it; the server checks its output with `readImageInfo` from the same package.

## What it does

- **`makeRenditions(file)`** returns a landscape and a portrait rendition of an image.
  - It decodes with `createImageBitmap(file, { imageOrientation: 'from-image' })`, so a phone photo's EXIF orientation is applied. It draws on an `OffscreenCanvas`.
  - Each rendition is the contract's `coverSize` against `SCREEN_BOX`: the smallest size that still covers 1920x1080 (landscape) or 1080x1920 (portrait). It is never larger than the original. This is the rule `sf build` applies with sharp, so a 3840x2160 photo becomes 1920x1080 and 3413x1920.
  - A JPEG is encoded as JPEG. Any other type (PNG, WebP, AVIF, GIF) is encoded as WebP, which keeps transparency. Quality is 0.85, as `sf build` uses.
  - Some files ship unchanged (`original: true`): a JPEG, PNG or WebP that needs no scaling and has no EXIF rotation, and any SVG (for both orientations).
  - Files over 50 MB are refused before decoding (`maxSourceBytes`).
  - A very long strip keeps its size under the cover rule (a 65,535x1,080 PNG already has a side in the box), so its rendition can be over the contract's `MAX_IMAGE_PIXELS`. `create_asset_upload` refuses it, before anything is uploaded; crop it first.
- **`sha256Hex(blob)`** returns the SHA-256 of the bytes, computed with Web Crypto. That needs a secure context (https or localhost), as the CMS is.
- **`uploadImage(file, { callTool, idempotencyKey? })`** runs the whole upload:
  1. It makes the renditions.
  2. It calls `create_asset_upload` with the key, so the same upload tried again makes one asset.
  3. It PUTs each file to the presigned URL it gets back. URLs within a minute of expiring (a retry gets the first call's) are renewed first with `renew_asset_upload`, for the same asset.
  4. It calls `finalize_asset`.

  `callTool(name, input)` calls a tool and throws on a refusal. In the CMS that is a POST to `/api/tools/:name`.
- **`uploadVideo(file, { callTool })`** uploads a video. Nothing is transcoded, so the file must already be one screens play:
  1. It checks the file with `@signforge/media-check`. A file that fails throws `VideoRejectedError` before anything is sent. The error's `problems` say why, and its message adds how to export a file that passes.
  2. It hashes the file. The whole file is read into memory; videos are capped at 500 MB.
  3. It calls `create_video_upload`.
  4. It PUTs each part to its presigned URL and keeps each response's `ETag`.
  5. It calls `finalize_video_upload`, which checks the file again on the server.
- **`readImageInfo(bytes)`** (also `@signforge/media/image-info`) returns the type and displayed size of a JPEG, PNG, WebP or SVG from its header, without decoding. For a JPEG, EXIF orientations 5 to 8 swap width and height, as a browser displays them. It is pure byte parsing and runs in a Worker; `finalize_asset` uses it.

The server does not trust any of this. It re-hashes the uploads and checks their type, size and box (see `packages/tools/README.md`).

## Tests

The browser is Playwright's Chromium, or the one at `SF_CHROMIUM`.

- `test/image-info.test.ts` runs `readImageInfo` against files encoded by sharp.
- `test/renditions.test.ts` runs `makeRenditions` in a real Chromium:
  - A 3840x2160 photo, stored rotated with EXIF orientation 6 and with a colour in each quadrant, becomes a 1920x1080 and a 3413x1920 JPEG. The colours are checked in the output bytes, so the pixels themselves are upright.
  - A transparent PNG is encoded as WebP with its alpha.
  - A small image and an SVG ship unchanged.
- The whole upload, images and video, is tested in `packages/tools/test/e2e/upload.test.ts`. It runs this library in Chromium, with presigned PUTs to Miniflare's S3 API and the tools checking what landed. It lives there because `tools` depends on this package.
