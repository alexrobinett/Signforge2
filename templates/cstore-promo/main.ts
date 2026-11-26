import { defineTemplate } from '@signforge/template-sdk';
import { painted, readableOn } from '@signforge/template-sdk/contrast';

// Text and images are bound by the SDK from the data-sf attributes in index.html.
defineTemplate({
  prepare(ctx) {
    // A kit may set an on-accent by hand that does not read on its accent (the brand tools only warn); the badge's
    // text then takes black or white. With no kit the CSS fallbacks are a pair.
    const kit = ctx.root.style;
    const accent = kit.getPropertyValue('--sf-accent');
    if (accent) {
      kit.setProperty('--sf-on-accent', readableOn(accent, kit.getPropertyValue('--sf-on-accent')));
      // The promo line is the accent on the stage: amber, for one, does not read on a light kit. The stage's glow is
      // centred right of the copy: in landscape the copy reaches its middle stop (the primary mixed 35% into the
      // background), in portrait, stacked above the products, its centre (70%); measured from there out to the
      // background. It is large text at 1080p (5.2vmin, bold), where 3:1 reads.
      const large = { large: true };
      const bg = kit.getPropertyValue('--sf-bg');
      const primary = kit.getPropertyValue('--sf-primary');
      const glow = ctx.root.dataset.orientation === 'portrait' ? 0.7 : 0.35;
      kit.setProperty('--accent-text', readableOn(painted(bg, [primary, glow]), readableOn(bg, accent, large), large));
    }
    // A line that is wider than the copy allows (a long name, or a wide brand font) is set
    // smaller to fit rather than cut off. One layout per line.
    for (const el of document.querySelectorAll<HTMLElement>('.line')) {
      if (el.scrollWidth > el.clientWidth + 1) el.style.fontSize = `${(parseFloat(getComputedStyle(el).fontSize) * el.clientWidth) / el.scrollWidth}px`;
    }
  },
});
