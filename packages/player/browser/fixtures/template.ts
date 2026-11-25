/**
 * The fixture template: one bundle whose behaviour each spot picks with its `mode` field.
 *   ok     report ready (the default)
 *   throw  throw in `prepare`, so the SDK reports an error
 *   hang   never resolve `prepare`, so it never reports ready
 * Hostile modes try to reach the spot's `target` URL (see `attacks` below). Those that navigate
 * then wait forever, so only the player can end the spot; the others throw once the attempt is
 * refused, as a template that does not handle a failed load would.
 * It shows `label` and lists the titles of `items` in `#box` the way a news template would, trusting
 * the shape (so `items: {}` throws), marks whether it received asset `file` and the size of the
 * sample beside it, runs a CSS animation the SDK must hold until play, and marks `play`.
 */
import { Sha256 } from '@signforge/player-core/sha256';
import { defineTemplate } from '@signforge/template-sdk';
import { sampleAsset } from '@signforge/template-sdk/backdrop';
import { bindRow } from '@signforge/template-sdk/rows';
import { attribute, childPage, childScript } from './child';

const forever = () => new Promise<never>(() => {});
const after = (ms: number) => new Promise((r) => setTimeout(r, ms));

const attacks: Record<string, (target: string) => unknown> = {
  navigate: (t) => void (location.href = t),
  'navigate-data': (t) => void (location.href = `data:text/html,<script>fetch(${JSON.stringify(t)})</script>`),
  'navigate-top': (t) => void (top!.location.href = t),
  refresh: (t) => {
    const m = document.createElement('meta');
    m.httpEquiv = 'refresh';
    m.content = `0;url=${t}`;
    document.head.appendChild(m);
  },
  link: (t) => {
    const a = document.createElement('a');
    a.href = t;
    document.body.appendChild(a);
    a.click();
  },
  form: (t) => {
    const f = document.createElement('form');
    f.action = t;
    f.method = 'get';
    document.body.appendChild(f);
    f.submit();
  },
  open: (t) => void window.open(t),
  iframe: (t) => {
    const f = document.createElement('iframe');
    f.src = t;
    document.body.appendChild(f);
  },
  fetch: (t) => fetch(t),
  image: (t) => {
    const img = new Image();
    img.src = t;
    return img.decode();
  },
  font: (t) => new FontFace('leak', `url(${t})`).load(),
  // A hash source also allows an external script whose `integrity` names it (CSP3 §8.4): the request
  // would be made before the response is checked. This names the hash of the template's own script.
  'external-script': (t) =>
    new Promise((resolve, reject) => {
      const own = new Sha256().update(new TextEncoder().encode(document.scripts[0]!.textContent)).hex();
      const s = document.createElement('script');
      s.src = t;
      s.integrity = `sha256-${btoa(String.fromCharCode(...own.match(/../g)!.map((b) => parseInt(b, 16))))}`;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    }),
  webrtc: async (t) => gather(RTCPeerConnection, t),
  // A frame of its own is a fresh realm: if it shared the template's origin, its RTCPeerConnection would be another way in.
  'webrtc-frame': async (t) => {
    const f = document.createElement('iframe');
    document.body.appendChild(f);
    return gather((f.contentWindow as typeof window).RTCPeerConnection, t);
  },
  // A frame the template adds runs script of its own (fixtures/child.ts), in a realm of its own.
  'webrtc-srcdoc': (t) => addChild((f) => (f.srcdoc = childPage(t, 1))),
  'webrtc-srcdoc-sandboxed': (t) => addChild((f) => ((f.sandbox.value = 'allow-scripts'), (f.srcdoc = childPage(t, 1)))),
  'webrtc-srcdoc-same-origin': (t) => addChild((f) => ((f.sandbox.value = 'allow-scripts allow-same-origin'), (f.srcdoc = childPage(t, 1)))),
  'webrtc-javascript-url': (t) => addChild((f) => (f.src = `javascript:void ${encodeURIComponent(childScript(t, 1))}`)),
  'webrtc-grandchild': (t) => addChild((f) => (f.srcdoc = `<iframe srcdoc="${attribute(childPage(t, 2))}"></iframe>`)),
  // The frame is in the bundle's markup (the test puts it there); the template only listens.
  'webrtc-markup': () => fromChild(),
};
/** Add a frame, set up by `set`, and wait for what its script reports. */
function addChild(set: (f: HTMLIFrameElement) => unknown): Promise<string | undefined> {
  const reported = fromChild();
  const f = document.createElement('iframe');
  set(f);
  document.body.appendChild(f);
  return reported;
}
/** What a frame below reports within 1.2 s: `gathered …`, or undefined if it found nothing or never ran. */
function fromChild(): Promise<string | undefined> {
  return new Promise((resolve) => {
    addEventListener('message', (e: MessageEvent<{ sfChild?: unknown }>) => {
      if (typeof e.data?.sfChild === 'string') resolve(e.data.sfChild ? `gathered ${e.data.sfChild}` : undefined);
    });
    setTimeout(() => resolve(undefined), 1200);
  });
}
/**
 * Open a peer connection to the ICE servers in `t` (space-separated) and collect candidates for a
 * second. Resolves with what it gathered, if anything: the test reads it in the spot's error.
 */
async function gather(PeerConnection: typeof RTCPeerConnection, t: string): Promise<string | undefined> {
  const found: string[] = [];
  const pc = new PeerConnection({ iceServers: t.split(' ').map((urls) => ({ urls, username: 'sf', credential: 'sf' })) });
  pc.onicecandidate = (e) => void (e.candidate && found.push(e.candidate.candidate));
  pc.createDataChannel('leak');
  await pc.setLocalDescription();
  await after(1000);
  pc.close();
  return found.length ? `gathered ${found.join(' | ')}` : undefined;
}
const navigates = new Set(['navigate', 'navigate-data', 'navigate-top', 'refresh', 'link']);

defineTemplate({
  async prepare(ctx) {
    document.body.dataset.prepared = '1';
    document.body.dataset.visibleInPrepare = getComputedStyle(document.getElementById('label')!).visibility;
    document.body.dataset.asset = ctx.assets.file ? '1' : '';
    const sample = ctx.assets[sampleAsset('file')];
    if (sample) {
      const img = new Image();
      img.src = sample;
      await img.decode();
      document.body.dataset.sample = `${img.naturalWidth}x${img.naturalHeight}`;
    }
    const mode = String(ctx.data.mode ?? 'ok');
    const target = String(ctx.data.target ?? '');
    if (mode === 'throw') throw new Error('fixture prepare failed');
    if (mode === 'hang') await forever();
    if (mode === 'navigate-on-play') (window as unknown as { sfTarget: string }).sfTarget = target;
    const attack = attacks[mode];
    if (attack) {
      const leaked = await Promise.resolve(attack(target)).catch(() => undefined);
      if (navigates.has(mode)) await forever();
      if (typeof leaked === 'string') throw new Error(`${mode} went through: ${leaked}`);
      await after(200);
      throw new Error(`${mode} was refused`);
    }
    const items = (ctx.data.items ?? []) as { title: string; image?: { file: string; thumb: string } }[];
    document.getElementById('box')!.textContent = items.map((i) => i.title).join(', ');
    if (items.length) {
      const ul = document.createElement('ul');
      ul.id = 'rows';
      items.forEach((item, i) => {
        const li = document.createElement('li');
        li.dataset.hasImage = item.image ? '1' : '0';
        li.innerHTML = '<span data-sf="title"></span><img class="lead" data-sf-src="image"><img class="thumb" data-sf-src="image:thumb">';
        bindRow(li, ctx, 'items', i);
        ul.appendChild(li);
      });
      document.body.appendChild(ul);
    }
  },
  play() {
    document.body.dataset.playing = '1';
    const target = (window as unknown as { sfTarget?: string }).sfTarget;
    if (target) location.href = target;
  },
});
