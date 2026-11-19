import { defineTemplate } from '@signforge/template-sdk';
import { painted, readableOn } from '@signforge/template-sdk/contrast';

// Text and images are bound by the SDK from the data-sf attributes in index.html.
defineTemplate({
  prepare(ctx) {
    // A kit may set an on-primary by hand that does not read on its primary (the brand tools only
    // warn); the badge's text then takes black or white. With no kit the CSS fallbacks are a pair.
    const kit = ctx.root.style;
    const primary = kit.getPropertyValue('--sf-primary');
    if (primary) {
      kit.setProperty('--sf-on-primary', readableOn(primary, kit.getPropertyValue('--sf-on-primary')));
      // The promo line is the kit's accent on the copy panel: amber, for one, does not read on a
      // light kit. The panel is the surface at 88% over the stage, which runs from the primary
      // mixed 70% into the background out to the background: measured over both ends.
      // It is large text at 1080p (5.2vmin, bold), where 3:1 reads.
      const large = { large: true };
      const bg = kit.getPropertyValue('--sf-bg');
      const surface = kit.getPropertyValue('--sf-surface');
      const accent = readableOn(painted(bg, [surface, 0.88]), kit.getPropertyValue('--sf-accent'), large);
      kit.setProperty('--accent-text', readableOn(painted(bg, [primary, 0.7], [surface, 0.88]), accent, large));
    }
    // A line that is wider than the panel allows (a long name, or a wide brand font) is set
    // smaller to fit rather than cut off. One layout per line.
    for (const el of document.querySelectorAll<HTMLElement>('.line')) {
      if (el.scrollWidth > el.clientWidth + 1) el.style.fontSize = `${(parseFloat(getComputedStyle(el).fontSize) * el.clientWidth) / el.scrollWidth}px`;
    }
  },
});
