/**
 * The runtime check's hostile fixture: the `mode` field's default picks what it tries. Network
 * calls are reached through `globalThis[...]` with a built name, so the source lint (which matches
 * `fetch(`) does not see them: what the lint misses, the runtime check must catch.
 */
import { defineTemplate } from '@signforge/template-sdk';

const TARGET = 'https://example.com/leak';
const reach = (name: string): ((...args: unknown[]) => unknown) => Reflect.get(globalThis, name);
const forever = () => new Promise<never>(() => {});

const attempts: Record<string, () => unknown> = {
  fetch: () => (reach(['fe', 'tch'].join('')) as (u: string) => Promise<unknown>)(TARGET).catch(() => undefined),
  'navigate-top': () => {
    try {
      top!.location.href = TARGET;
    } catch {
      // Refused by the sandbox; the check reads Chromium's report of the attempt.
    }
  },
  'navigate-self': () => Reflect.set(location, 'href', TARGET),
  'no-ready': forever,
  throw: () => {
    throw new Error('prepare blew up');
  },
  uncaught: () => {
    setTimeout(() => {
      throw new Error('late failure');
    });
  },
  webrtc: () => new (Reflect.get(globalThis, 'RTCPeerConnection') as new () => object)(),
  image: () => {
    const img = new Image();
    img.src = TARGET;
  },
};

defineTemplate({
  async prepare(ctx) {
    await attempts[String(ctx.data.mode)]?.();
  },
  play(ctx) {
    if (ctx.data.mode === 'on-play') Reflect.set(location, 'href', TARGET);
  },
});
