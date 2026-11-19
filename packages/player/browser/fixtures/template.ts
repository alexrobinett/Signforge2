/**
 * The fixture template: one bundle whose behaviour each spot picks with its `mode` field.
 *   ok     report ready (the default)
 *   throw  throw in `prepare`, so the SDK reports an error
 *   hang   never resolve `prepare`, so it never reports ready
 * Hostile modes try to reach the spot's `target` URL (see `attacks` below). Those that navigate
 * then wait forever, so only the player can end the spot; the others throw once the attempt is
 * refused, as a template that does not handle a failed load would.
 * It shows `label` and lists the titles of `items` in `#box` the way a news template would, trusting
 * the shape (so `items: {}` throws), marks whether it received asset `file`, runs a CSS animation
 * the SDK must hold until play, and marks `play`.
 */
import { defineTemplate } from '@signforge/template-sdk';

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
  webrtc: async (t) => gather(RTCPeerConnection, t),
  // A frame of its own is a fresh realm: if it shared the template's origin, its RTCPeerConnection would be another way in.
  'webrtc-frame': async (t) => {
    const f = document.createElement('iframe');
    document.body.appendChild(f);
    return gather((f.contentWindow as typeof window).RTCPeerConnection, t);
  },
};
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
    const items = (ctx.data.items ?? []) as { title: string }[];
    document.getElementById('box')!.textContent = items.map((i) => i.title).join(', ');
  },
  play() {
    document.body.dataset.playing = '1';
    const target = (window as unknown as { sfTarget?: string }).sfTarget;
    if (target) location.href = target;
  },
});
