import { dayKey, defineTemplate, formatter, now as clockNow } from '@signforge/template-sdk';
import { painted, readableOn } from '@signforge/template-sdk/contrast';

interface Event {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
}

/** An all-day `YYYY-MM-DD` is a calendar date, not an instant: read it at noon UTC so no time zone moves it. */
const asDate = (s: string, allDay: boolean) => (allDay ? new Date(`${s.slice(0, 10)}T12:00:00Z`) : new Date(s));

defineTemplate({
  prepare(ctx) {
    const root = document.documentElement;
    const accent = String(ctx.data.accent);
    root.style.setProperty('--accent', accent);
    // Accent text must read where it sits (amber, for one, does not on a light kit): the date on
    // the background and on the surface its gradient starts from.
    const style = getComputedStyle(root);
    const bg = style.getPropertyValue('--bg');
    const surface = style.getPropertyValue('--surface');
    root.style.setProperty('--accent-text', readableOn(surface, readableOn(bg, accent)));
    const now = clockNow();
    const today = dayKey(ctx, now);
    const tomorrow = dayKey(ctx, new Date(now.getTime() + 864e5));
    document.getElementById('today')!.textContent = formatter(ctx, { weekday: 'long', month: 'long', day: 'numeric' }).format(now);

    const all = (ctx.data.events as Event[]) ?? [];
    // An all-day event's end date is exclusive: it is over once that date arrives.
    const upcoming = all.filter((e) => (e.allDay ? (e.end ? e.end.slice(0, 10) > today : e.start.slice(0, 10) >= today) : new Date(e.end || e.start) > now));
    // As many rows as the space holds (trimmed below), up to the spot's limit.
    const rows = upcoming.slice(0, Math.max(1, Math.min(25, Number(ctx.data.rows) || 25)));
    document.getElementById('empty')!.hidden = rows.length > 0;

    const list = document.getElementById('events')!;
    const tpl = document.getElementById('row') as HTMLTemplateElement;
    const time = formatter(ctx, { hour: 'numeric', minute: '2-digit' });
    // All-day dates are formatted in UTC to keep them on the date they name.
    const utc = { ...ctx, timezone: 'UTC' };
    rows.forEach((e, i) => {
      const li = tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
      li.style.setProperty('--i', String(i));
      const start = asDate(e.start, e.allDay);
      const dateCtx = e.allDay ? utc : ctx;
      const q = (sel: string) => li.querySelector(sel)!;
      q('.dow').textContent = formatter(dateCtx, { weekday: 'short' }).format(start);
      q('.num').textContent = formatter(dateCtx, { day: 'numeric' }).format(start);
      q('.mon').textContent = formatter(dateCtx, { month: 'short' }).format(start);
      const key = e.allDay ? e.start.slice(0, 10) : dayKey(ctx, start);
      const label = key === today ? 'Today' : key === tomorrow ? 'Tomorrow' : '';
      const happening = !e.allDay && start <= now && new Date(e.end) > now;
      const span = e.allDay ? 'All day' : `${time.format(start)}${e.end ? ` – ${time.format(new Date(e.end))}` : ''}`;
      q('.when').textContent = [happening ? 'Happening now' : label, span].filter(Boolean).join(' · ');
      q('.name').textContent = e.title;
      q('.where').textContent = e.location;
      if (happening || (e.allDay && key === today)) li.classList.add('now');
      list.appendChild(li);
    });
    // Show only whole rows: drop from the end until the list fits its space.
    while (list.children.length > 1 && list.scrollHeight > list.clientHeight + 1) list.lastElementChild!.remove();
    // A row's day is the accent on its card, which mixes the surface with the text (or, happening
    // now, is the accent over the stage): a translucent card is measured over both ends of the
    // stage's gradient. Rows share two kinds of card, so each is read once.
    const days = new Map<string, string>();
    for (const li of list.children) {
      const card = getComputedStyle(li).backgroundColor;
      if (!days.has(card)) days.set(card, readableOn(painted(surface, card), readableOn(painted(bg, card), accent)));
      (li as HTMLElement).style.setProperty('--day-text', days.get(card)!);
    }
  },
});
