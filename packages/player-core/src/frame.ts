/**
 * The document a template runs in, shared by the player (`packages/player/src/slot.ts`) and the
 * runtime check (`apps/template-check`), so a template is checked in exactly the sandbox and policy
 * screens give it. See "Template containment" in docs/architecture.md.
 */

/** A spot that has not reported ready by this point is skipped. */
export const READY_TIMEOUT_MS = 2000;

// A template gets no network at all: scripts and styles are inline, media arrives as blobs. No
// `frame-src`, so it falls back to `'none'`: the template cannot load a frame or navigate its own.
const TEMPLATE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; media-src blob:; font-src data:";

/**
 * The wrapper frame's `srcdoc`, around each template. Its one script is `relay`: templates accept
 * messages only from their `parent`, which is the wrapper, and a message's source is the window
 * whose code called postMessage. So the host posts through a function of the wrapper.
 */
export const WRAPPER_HTML =
  `<!doctype html><meta http-equiv="Content-Security-Policy" content="${TEMPLATE_CSP}">` +
  '<style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style>' +
  "<script>relay=(w,m)=>w.postMessage(m,'*')</script>";

/** The template frame's `sandbox`: scripts only, so an opaque origin, no popups, forms or navigating other frames. */
export const TEMPLATE_SANDBOX = 'allow-scripts';
