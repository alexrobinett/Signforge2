import { defineTemplate, formatter } from '@signforge/template-sdk';

interface Item {
  title: string;
  published: string;
  source: string;
}

function ago(iso: string, now: Date): string {
  const t = new Date(iso).getTime();
  if (!iso || Number.isNaN(t)) return '';
  const mins = Math.max(0, Math.round((now.getTime() - t) / 60000));
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs} hr ago` : `${Math.round(hrs / 24)} d ago`;
}

defineTemplate({
  prepare(ctx) {
    const root = document.documentElement;
    root.style.setProperty('--accent', String(ctx.data.accent));
    const now = new Date();
    const items = ((ctx.data.items as Item[]) ?? []).filter((i) => i.title);
    const [lead, ...rest] = items;
    document.getElementById('clock')!.textContent = formatter(ctx, { hour: 'numeric', minute: '2-digit' }).format(now);
    const credit = String(ctx.data.source || lead?.source || '');
    document.getElementById('credit')!.textContent = credit;
    if (lead) {
      document.getElementById('lead')!.textContent = lead.title;
      document.getElementById('age')!.textContent = ago(lead.published, now);
    }
    const more = document.getElementById('more')!;
    for (const item of rest.slice(0, 3)) {
      const li = document.createElement('li');
      li.textContent = item.title;
      more.appendChild(li);
    }

    // The crawl holds the headlines twice and slides by exactly one copy, so it loops seamlessly.
    const crawl = document.getElementById('crawl')!;
    if (!items.length) return;
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
