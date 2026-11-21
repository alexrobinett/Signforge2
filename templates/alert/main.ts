import { defineTemplate } from '@signforge/template-sdk';
import { qrSvg } from '@signforge/template-sdk/qr';

/**
 * Each severity's word and colours: ink on its ground, and the band the other way round. Fixed on
 * purpose, whatever the screen's brand kit: a kit's colours must not decide whether an evacuation
 * notice reads. Every pair is 7:1 or better.
 */
const SEVERITIES: Record<string, { label: string; ground: string; ink: string }> = {
  emergency: { label: 'Emergency', ground: '#991b1b', ink: '#ffffff' },
  warning: { label: 'Warning', ground: '#f59e0b', ink: '#111827' },
  advisory: { label: 'Advisory', ground: '#fde047', ink: '#111827' },
  notice: { label: 'Notice', ground: '#1e3a8a', ink: '#ffffff' },
};

/** The type's steps down, tried in turn until the copy fits: copy at every field's `maxLength` fits at the last. */
const FITS = [1, 0.88, 0.77, 0.68];

defineTemplate({
  async prepare(ctx) {
    const { root, data } = ctx;
    const severity = SEVERITIES[String(data.severity)]!;
    root.dataset.severity = String(data.severity);
    root.style.setProperty('--ground', severity.ground);
    root.style.setProperty('--ink', severity.ink);
    document.getElementById('label')!.textContent = severity.label;
    document.getElementById('ends')!.textContent = `Ends at ${String(data.endsAt)}`;

    // The look kit's toggle convention (docs/template-spec.md, Looks): a mark on the root, and what
    // is off removed, so the grid closes up. A QR code with no address is off.
    const url = String(data.qrUrl);
    const shown = { qr: data.showQr === true && url !== '', 'issued-by': data.showIssuedBy === true, 'ends-at': data.showEndsAt === true };
    for (const [mark, on] of Object.entries(shown)) {
      root.setAttribute(`data-${mark}`, on ? 'on' : 'off');
      if (!on) for (const el of document.querySelectorAll(`[data-show="${mark}"]`)) el.remove();
    }
    if (shown.qr) document.getElementById('qr')!.replaceChildren(qrSvg(url, String(data.qrLabel)));

    // Measured in the template's own faces: lay out, so they load, then wait for them.
    const body = document.querySelector<HTMLElement>('.body')!;
    body.getBoundingClientRect();
    await document.fonts.ready;
    for (const fit of FITS) {
      root.style.setProperty('--fit', String(fit));
      if (body.scrollHeight <= body.clientHeight) break;
    }
  },
});
