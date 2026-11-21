import { defineTemplate } from '@signforge/template-sdk';
import { applyLook, crawl } from '@signforge/template-looks';

defineTemplate({
  async prepare(ctx) {
    await applyLook(ctx);
    const strip = document.getElementById('crawl');
    if (strip) crawl(strip, ctx);
  },
});
