import { defineTemplate } from '@signforge/template-sdk';
import { readableOn } from '@signforge/template-sdk/contrast';

// Text and images are bound by the SDK from the data-sf attributes in index.html.
defineTemplate({
  prepare(ctx) {
    // A kit may set an on-primary by hand that does not read on its primary (the brand tools only
    // warn); the price tag's text then takes black or white. With no kit the CSS fallbacks are a pair.
    const kit = ctx.root.style;
    const primary = kit.getPropertyValue('--sf-primary');
    if (primary) {
      kit.setProperty('--sf-on-primary', readableOn(primary, kit.getPropertyValue('--sf-on-primary')));
      // The eyebrow is the kit's accent on a shade of its background over the photo: amber, for one,
      // does not read on a light kit. It is large text, but measured on the background and not on
      // the photo, so it keeps 4.5:1 there rather than 3:1 (#124).
      kit.setProperty('--accent-text', readableOn(kit.getPropertyValue('--sf-bg'), kit.getPropertyValue('--sf-accent')));
    }
  },
});
