import { defineTemplate } from '@signforge/template-sdk';

// Text and images are bound by the SDK from the data-sf attributes in index.html.
defineTemplate({
  prepare() {
    // A line that is wider than the panel allows (a long name, or a wide brand font) is set
    // smaller to fit rather than cut off. One layout per line.
    for (const el of document.querySelectorAll<HTMLElement>('.line')) {
      if (el.scrollWidth > el.clientWidth + 1) el.style.fontSize = `${(parseFloat(getComputedStyle(el).fontSize) * el.clientWidth) / el.scrollWidth}px`;
    }
  },
});
