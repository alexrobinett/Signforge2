/**
 * The documents a template runs in, shared by the player (`packages/player/src/slot.ts`) and the
 * runtime check (`apps/template-check`), so a template is checked in exactly the sandbox and policy
 * screens give it. See "Template containment" in docs/architecture.md.
 *
 * No policy directive covers WebRTC, so a peer connection would reach STUN and TURN servers. The
 * policy therefore runs only scripts the host has hashed, and every one of them starts by deleting
 * the peer connection constructors from its realm. A frame the template adds, by script or in its
 * markup, can run nothing but those same scripts, so its realm is disarmed before anything else in
 * it runs. Inline event handlers and `javascript:` URLs do not run at all.
 */
import { Sha256 } from './sha256';

/** A spot that has not reported ready by this point is skipped. */
export const READY_TIMEOUT_MS = 2000;

const DISARM = 'delete window.RTCPeerConnection;delete window.webkitRTCPeerConnection;';
// The wrapper's one script. Templates accept messages only from their `parent`, which is the
// wrapper, and a message's source is the window whose code called postMessage, so the host posts
// through this function of the wrapper.
const RELAY = "relay=(w,m)=>w.postMessage(m,'*')";

/** An inline script's start tag and its text, up to its end tag. */
const SCRIPT = /(<script\b[^>]*>)([\s\S]*?)(?=<\/script[\s/>])/gi;
/** A script whose `type` is not JavaScript is a data block: it never runs, and is left as it is. */
const DATA_BLOCK = /\stype\s*=\s*["']?(?!module\b|text\/javascript\b|application\/javascript\b)[^\s"'>]/i;
/** A leading "use strict" must stay first, or the script loses strict mode. */
const STRICT = /^\s*(["'])use strict\1/;

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
 * The wrapper and the template's document for a bundle. A script this does not recognise as one (an
 * odd end tag, a script in SVG with character references) keeps its text but does not match any
 * hash, so it is refused: the template fails, nothing more.
 */
export function containedFrames(bundle: string): { wrapper: string; template: string } {
  const scripts = [RELAY];
  // The parser reads CR LF and CR as LF before a script's text is hashed.
  const template = bundle.replace(/\r\n?/g, '\n').replace(SCRIPT, (_, start: string, text: string) => {
    if (DATA_BLOCK.test(start)) return start + text;
    const strict = STRICT.exec(text)?.[0] ?? '';
    const armed = `${strict};${DISARM}${text.slice(strict.length)}`;
    scripts.push(armed);
    return start + armed;
  });
  // No network at all: styles are inline, media arrives as blobs. No `frame-src`, so it falls back
  // to `'none'`: the template cannot load a frame or navigate its own.
  const policy = `default-src 'none'; script-src ${scripts.map(hashSource).join(' ')}; style-src 'unsafe-inline'; img-src blob: data:; media-src blob:; font-src data:`;
  const wrapper =
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}">` +
    '<style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style>' +
    `<script>${RELAY}</script>`;
  return { wrapper, template };
}

/** The template frame's `sandbox`: scripts only, so an opaque origin, no popups, forms or navigating other frames. */
export const TEMPLATE_SANDBOX = 'allow-scripts';
