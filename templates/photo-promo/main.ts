import { defineTemplate } from '@signforge/template-sdk';
import { readableOn } from '@signforge/template-sdk/contrast';

// Text and images are bound by the SDK from the data-sf attributes in index.html.
defineTemplate({
  prepare(ctx) {
    // A kit may set an on-primary by hand that does not read on its primary (the brand tools only
    // warn); the price tag's text then takes black or white. With no kit the CSS fallbacks are a pair.
    const primary = ctx.root.style.getPropertyValue('--sf-primary');
    if (primary) ctx.root.style.setProperty('--sf-on-primary', readableOn(primary, ctx.root.style.getPropertyValue('--sf-on-primary')));
  },
});
