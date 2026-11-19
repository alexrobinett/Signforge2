import { defineTemplate, fitWords, formatter, now as clockNow } from '@signforge/template-sdk';
import { readableOn } from '@signforge/template-sdk/contrast';

interface Item {
  title: string;
  published: string;
  source: string;
}

/** "33 minutes ago", "il y a 2 heures": the item's age in the feed's language. */
function ago(iso: string, now: Date, locale: string): string {
  const t = new Date(iso).getTime();
  if (!iso || Number.isNaN(t)) return '';
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const mins = Math.max(0, Math.round((now.getTime() - t) / 60000));
  if (mins < 60) return rtf.format(-mins, 'minute');
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? rtf.format(-hrs, 'hour') : rtf.format(-Math.round(hrs / 24), 'day');
}

/** Shorten an element's text to whole words that fit its box. Only text that overflows costs layouts. */
function ellipsize(el: HTMLElement): void {
  const text = el.textContent ?? '';
  if (!text) return;
  // Glyphs overhang a tight line-height by a few pixels; text cut by a line clamp overflows by a
  // whole line. Half a line tells them apart.
  const slack = parseFloat(getComputedStyle(el).fontSize) / 2;
  el.textContent = fitWords(text, (s) => {
    el.textContent = s;
    return el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + slack;
  });
}

defineTemplate({
  prepare(ctx) {
    const root = document.documentElement;
    const accent = String(ctx.data.accent);
    root.style.setProperty('--accent', accent);
    // The badge is the spot's accent, which need not be the kit's (with no kit it is the default
    // palette's amber, where the template's white text read at 2.14:1): its text is chosen against it.
    const style = getComputedStyle(root);
    root.style.setProperty('--on-accent', readableOn(accent, style.getPropertyValue('--on-accent')));
    // The age line is the accent on the background: amber, for one, does not read on a light kit.
    // It is large text at 1080p (3.2vmin, 35 px), where 3:1 reads.
    root.style.setProperty('--accent-text', readableOn(style.getPropertyValue('--bg'), accent, { large: true }));
    const now = clockNow();
    const items = ((ctx.data.items as Item[]) ?? []).filter((i) => i.title);
    const [lead, ...rest] = items;
    document.getElementById('clock')!.textContent = formatter(ctx, { hour: 'numeric', minute: '2-digit' }).format(now);
    const credit = String(ctx.data.source || lead?.source || '');
    document.getElementById('credit')!.textContent = credit;
    if (lead) {
      document.getElementById('lead')!.textContent = lead.title;
      // The age sits under the feed's own words, so it is in the feed's language; the screen's when the feed declares none.
      document.getElementById('age')!.textContent = ago(lead.published, now, String(ctx.data.language || ctx.locale));
    }
    // Portrait has the height for more secondary headlines; drop any that do not fit.
    const more = document.getElementById('more')!;
    for (const item of rest.slice(0, ctx.orientation === 'portrait' ? 5 : 4)) {
      const li = document.createElement('li');
      li.textContent = item.title;
      more.appendChild(li);
    }
    const main = document.querySelector('main')!;
    while (more.children.length && main.scrollHeight > main.clientHeight + 1) more.lastElementChild!.remove();
    // Text that does not fit ends on a whole word ("rain…"), not after a space as CSS cuts it ("rain …").
    for (const el of [document.getElementById('lead')!, document.getElementById('credit')!, ...more.children]) ellipsize(el as HTMLElement);

    // The crawl holds the headlines twice and slides by exactly one copy, so it loops seamlessly.
    const crawl = document.getElementById('crawl')!;
    // With no headlines (a feed that failed or has not loaded yet) there is no crawl: hide the bar
    // rather than show an empty white strip.
    if (!items.length) {
      document.querySelector('footer')!.hidden = true;
      return;
    }
    for (let copy = 0; copy < 2; copy++) {
      for (const item of items) {
        const span = document.createElement('span');
        span.textContent = item.title;
        crawl.appendChild(span);
      }
    }
    const copyWidth = crawl.scrollWidth / 2;
    const pxPerSec = (ctx.viewport.width * Number(ctx.data.crawlSpeed || 6)) / 60;
    root.style.setProperty('--crawl-shift', `${-copyWidth}px`);
    root.style.setProperty('--crawl-s', `${copyWidth / pxPerSec}s`);
  },
});
