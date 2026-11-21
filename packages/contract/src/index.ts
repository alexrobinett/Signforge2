/**
 * The SignForge contract: every shape that crosses a boundary.
 *
 *   template author  <-> player   TemplateManifest, the frame protocol
 *   publisher        <-> player   ScreenManifest
 *   screen           <-> server   the device API: pairing, sync, socket messages
 *
 * Nothing here depends on a browser or on Node. The shapes and their constants are in
 * `shapes.ts`, the runtime checks for every shape in `validate.ts`, and `parse.ts` turns each check
 * into a parser that hands back the typed value. `frame.ts` holds the few values a template bundle
 * carries; the template SDK imports them alone, as `@signforge/contract/frame`, and `sample.ts` those
 * of an image's sample, as `@signforge/contract/sample`, which only a template that reads one carries.
 *
 * Versioning. Screens and template bundles outlive any one release, so both versions are ranges:
 *  - A template bundle records the frame protocol it was built against (`TemplateManifest.protocol`)
 *    and the player speaks every protocol in SUPPORTED_PROTOCOLS. A bundle is immutable; a protocol
 *    change must never strand templates already published.
 *  - A player reports the manifest schemas it can play in every sync. The server compiles each
 *    screen at the newest schema that screen supports, and tells an outdated player to reload.
 *  - A player release plays schema N and N-1, so a screen updated while offline still plays the
 *    manifest it cached under the previous release.
 */

export * from './frame.ts';
export * from './sample.ts';
export * from './shapes.ts';
export * from './validate.ts';
export * from './parse.ts';
export * from './scripts.ts';
