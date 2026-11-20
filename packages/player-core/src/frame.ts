/**
 * The documents a template runs in, shared by the player (`packages/player/src/slot.ts`) and the
 * runtime check (`apps/template-check`), so a template is checked in exactly the sandbox and policy
 * screens give it. See "Template containment" in docs/architecture.md.
 *
 * No policy directive covers WebRTC, so a peer connection would reach STUN and TURN servers. The
 * policy therefore runs only the bundle's classic scripts that start with exactly `"use strict";`
 * (TEMPLATE_SCRIPT_START, which the bundle check requires), by hash, and each goes on, right after
 * those bytes, by deleting the peer connection constructors from its realm. A frame the template
 * adds, by script or in its markup, can run nothing but those same scripts, so its realm is disarmed
 * before anything else in it runs. Inline modules, external scripts, inline event handlers and
 * `javascript:` URLs do not run at all.
 */
import { bundleScripts, TEMPLATE_SCRIPT_START } from '@signforge/contract';
import { Sha256 } from './sha256';

/** A spot that has not reported ready by this point is skipped. */
export const READY_TIMEOUT_MS = 2000;

// `this`, not `window`: a keyword no binding can shadow. At a classic script's top level it is the
// global object; a hash allows a text whatever its type, and run as a module the same text finds
// `this` undefined and throws before any of it runs. A delete that does not take throws too.
const DISARM = "if(!(delete this.RTCPeerConnection&&delete this.webkitRTCPeerConnection))throw new Error('[sf] WebRTC could not be removed');";
// The wrapper's one script. Templates accept messages only from their `parent`, which is the
// wrapper, and a message's source is the window whose code called postMessage, so the host posts
// through this function of the wrapper.
const RELAY = "relay=(w,m)=>w.postMessage(m,'*')";

/** A CSP hash source. With our own SHA-256: WebCrypto exists only in a secure context, which a player framed from an http page is not. */
const hashSource = (text: string): string =>
  `'sha256-${btoa(
    String.fromCharCode(
      ...new Sha256()
        .update(new TextEncoder().encode(text))
        .hex()
        .match(/../g)!
        .map((b) => parseInt(b, 16)),
    ),
  )}'`;

/**
 * The wrapper and the template's document for a bundle. Its scripts are read as the browser reads
 * them (`bundleScripts`): each one that runs gets the guard right after its first bytes and a hash,
 * and nothing else in the bundle changes. Any other script gets no hash, so it does not run.
 */
export function containedFrames(bundle: string): { wrapper: string; template: string } {
  const { html, scripts: found } = bundleScripts(bundle);
  const scripts = [RELAY];
  let template = '';
  let at = 0;
  for (const s of found) {
    if (!s.runs) continue;
    // `runs` means the text starts with exactly TEMPLATE_SCRIPT_START, a complete directive: no parsing.
    const armed = TEMPLATE_SCRIPT_START + DISARM + html.slice(s.start + TEMPLATE_SCRIPT_START.length, s.end);
    scripts.push(armed);
    template += html.slice(at, s.start) + armed;
    at = s.end;
  }
  template += html.slice(at);
  // No network at all: styles are inline, media arrives as blobs. No `frame-src`, so it falls back
  // to `'none'`: the template cannot load a frame or navigate its own.
  const policy = `default-src 'none'; script-src ${scripts.map(hashSource).join(' ')}; style-src 'unsafe-inline'; img-src blob: data:; media-src blob:; font-src data:`;
  // A hash also allows an external script whose `integrity` names it (CSP3 §8.4), and the request
  // would be made before the response is checked. A script must pass both policies, and this one
  // allows no URL, so no script is ever requested.
  const inlineOnly = "script-src 'unsafe-inline'";
  const wrapper =
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}">` +
    `<meta http-equiv="Content-Security-Policy" content="${inlineOnly}">` +
    '<style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style>' +
    `<script>${RELAY}</script>`;
  return { wrapper, template };
}

/** The template frame's `sandbox`: scripts only, so an opaque origin, no popups, forms or navigating other frames. */
export const TEMPLATE_SANDBOX = 'allow-scripts';
