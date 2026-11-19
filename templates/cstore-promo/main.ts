import { defineTemplate } from '@signforge/template-sdk';
import { readableOn } from '@signforge/template-sdk/contrast';

// Text and images are bound by the SDK from the data-sf attributes in index.html.
defineTemplate({
  prepare(ctx) {
    // A kit may set an on-primary by hand that does not read on its primary (the brand tools only
    // warn); the badge's text then takes black or white. With no kit the CSS fallbacks are a pair.
    const kit = ctx.root.style;
    const primary = kit.getPropertyValue('--sf-primary');
    if (primary) {
      kit.setProperty('--sf-on-primary', readableOn(primary, kit.getPropertyValue('--sf-on-primary')));
      // The promo line is the kit's accent on its surface (the copy panel): amber, for one, does not
      // read on a light kit.
      kit.setProperty('--accent-text', readableOn(kit.getPropertyValue('--sf-surface'), kit.getPropertyValue('--sf-accent')));
    }
    // A line that is wider than the panel allows (a long name, or a wide brand font) is set
    // smaller to fit rather than cut off. One layout per line.
    for (const el of document.querySelectorAll<HTMLElement>('.line')) {
      if (el.scrollWidth > el.clientWidth + 1) el.style.fontSize = `${(parseFloat(getComputedStyle(el).fontSize) * el.clientWidth) / el.scrollWidth}px`;
    }
  },
});
