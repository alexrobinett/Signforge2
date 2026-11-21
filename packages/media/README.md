# @signforge/media

Images and videos for screens, prepared in the browser before upload. The CMS's asset library uses it; the server checks its output with `readImageInfo` from the same package.

## What it does

- **`makeRenditions(file)`** returns a landscape and a portrait rendition of an image.
  - It decodes with `createImageBitmap(file, { imageOrientation: 'from-image' })`, so a phone photo's EXIF orientation is applied. It draws on an `OffscreenCanvas`.
  - Each rendition is the contract's `coverSize` against `SCREEN_BOX`: the smallest size that still covers 1920x1080 (landscape) or 1080x1920 (portrait). It is never larger than the original. This is the rule `sf build` applies with sharp, so a 3840x2160 photo becomes 1920x1080 and 3413x1920.
  - A JPEG is encoded as JPEG. Any other type (PNG, WebP, AVIF, GIF) is encoded as WebP, which keeps transparency. Quality is 0.85, as `sf build` uses.
  - Some files ship unchanged (`original: true`): a JPEG, PNG or WebP that needs no scaling and has no EXIF rotation, and any SVG (for both orientations).
  - Files over 50 MB are refused before decoding (`maxSourceBytes`).
  - Each raster rendition with no transparent pixel has a `sample`: its darkest and lightest pixel in each 16 px cell, as a PNG (the contract's `ManifestFile.sample`). It is made from the rendition's own bytes decoded again, as a screen decodes them, since an encoder's ringing is detail the screen shows. A template that measures its text over the photo reads it instead of decoding the photo (photo-promo). What shows through a transparent pixel is known only where it plays, so such an image has none.
  - A very long strip keeps its size under the cover rule (a 65,535x1,080 PNG already has a side in the box), so its rendition can be over the contract's `MAX_IMAGE_PIXELS`. `create_asset_upload` refuses it, before anything is uploaded; crop it first.
- **`sha256Hex(blob)`** returns the SHA-256 of the bytes, computed with Web Crypto. That needs a secure context (https or localhost), as the CMS is.
- **`uploadImage(file, { callTool, idempotencyKey? })`** runs the whole upload:
  1. It makes the renditions.
  2. It calls `create_asset_upload` with the key, so the same upload tried again makes one asset.
  3. It PUTs each file, samples included, to the presigned URL it gets back. URLs within a minute of expiring (a retry gets the first call's) are renewed first with `renew_asset_upload`, for the same asset.
  4. It calls `finalize_asset`.

  `callTool(name, input)` calls a tool and throws on a refusal. In the CMS that is a POST to `/api/tools/:name`.
- **`uploadVideo(file, { callTool })`** uploads a video. Nothing is transcoded, so the file must already be one screens play:
  1. It checks the file with `@signforge/media-check`. A file that fails throws `VideoRejectedError` before anything is sent. The error's `problems` say why, and its message adds how to export a file that passes.
  2. It hashes the file. The whole file is read into memory; videos are capped at 500 MB.
  3. It calls `create_video_upload`.
  4. It PUTs each part to its presigned URL and keeps each response's `ETag`.
  5. It calls `finalize_video_upload`, which checks the file again on the server.
- **`imageSample(rgba, width, height)`** (also `@signforge/media/sample`) makes a sample's pixels from an image's: each cell's darkest and lightest pixel by WCAG luminance, or undefined when a pixel is not opaque. It is pure, so `sf build` makes the same sample with sharp (libvips decodes a JPEG a level apart from Chromium on some pixels).
- **`encodePng(rgba, width, height)`** (`@signforge/media/png`) writes RGBA pixels as a PNG with `CompressionStream`, so a Worker can write a sample with no canvas or sharp: the API's feed photos (apps/api `src/data/images.ts`).
- **`readImageInfo(bytes)`** (also `@signforge/media/image-info`) returns the type and displayed size of a JPEG, PNG, WebP or SVG from its header, without decoding. For a JPEG, EXIF orientations 5 to 8 swap width and height, as a browser displays them. It is pure byte parsing and runs in a Worker; `finalize_asset` uses it.

The server does not trust any of this. It re-hashes the uploads and checks their type, size and box (see `packages/tools/README.md`).

## Tests

The browser is Playwright's Chromium, or the one at `SF_CHROMIUM`.

- `test/image-info.test.ts` runs `readImageInfo` against files encoded by sharp.
- `test/renditions.test.ts` runs `makeRenditions` in a real Chromium:
  - A 3840x2160 photo, stored rotated with EXIF orientation 6 and with a colour in each quadrant, becomes a 1920x1080 and a 3413x1920 JPEG. The colours are checked in the output bytes, so the pixels themselves are upright.
  - A transparent PNG is encoded as WebP with its alpha.
  - Each rendition of the photo has its sample, within one level of the sample sharp makes of the same bytes (the two JPEG decoders differ by a level on some pixels); the transparent PNG and the SVG have none.
  - A small image and an SVG ship unchanged.
- `test/png.test.ts` reads `encodePng`'s output back with sharp, pixel for pixel.
- `test/sample.test.ts` runs `imageSample` on pixels: each cell's darkest and lightest by luminance, not by channel, cells cut by the edge, and none for an image with a pixel not opaque.
- The whole upload, images and video, is tested in `packages/tools/test/e2e/upload.test.ts`. It runs this library in Chromium, with presigned PUTs to Miniflare's S3 API and the tools checking what landed. It lives there because `tools` depends on this package.
