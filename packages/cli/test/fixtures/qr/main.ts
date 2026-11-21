import { defineTemplate } from '@signforge/template-sdk';
import { qrSvg } from '@signforge/template-sdk/qr';

defineTemplate({
  prepare(ctx) {
    document.getElementById('qr')!.replaceChildren(qrSvg(String(ctx.data.link), 'Link'));
  },
});
