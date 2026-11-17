/**
 * The fixture template: one bundle whose behaviour each spot picks with its `mode` field.
 *   ok     report ready (the default)
 *   throw  throw in `prepare`, so the SDK reports an error
 *   hang   never resolve `prepare`, so it never reports ready
 * It shows `label` and lists the titles of `items` in `#box` the way a news template would, trusting
 * the shape (so `items: {}` throws), runs a CSS animation the SDK must hold until play, and marks `play`.
 */
import { defineTemplate } from '@signforge/template-sdk';

defineTemplate({
  async prepare(ctx) {
    document.body.dataset.prepared = '1';
    const mode = String(ctx.data.mode ?? 'ok');
    if (mode === 'throw') throw new Error('fixture prepare failed');
    if (mode === 'hang') await new Promise(() => {});
    const items = (ctx.data.items ?? []) as { title: string }[];
    document.getElementById('box')!.textContent = items.map((i) => i.title).join(', ');
  },
  play() {
    document.body.dataset.playing = '1';
  },
});
