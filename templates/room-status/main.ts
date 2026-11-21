import { dayKey, defineTemplate, formatter, now as clockNow, type TemplateContext } from '@signforge/template-sdk';
import { painted, readableOn } from '@signforge/template-sdk/contrast';
import { applyLook, LOOKS } from '@signforge/template-looks';

type Look = (typeof LOOKS)[number];

/** A row of the `events` field, as the calendar feed (`CalendarFeed`) writes it. */
interface Booking {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  organizer: string;
}

interface Meeting {
  title: string;
  organizer: string;
  start: Date;
  end: Date;
}

const MINUTE = 60_000;

const WORDS: Record<Look, [free: string, busy: string]> = {
  pop: ['Free!', 'Busy'],
  poster: ['Available', 'In use'],
  night: ['Free', 'Busy'],
  corporate: ['Available', 'In use'],
};

/** The date beside the clock, in the looks that show one. */
const DATES: Partial<Record<Look, Intl.DateTimeFormatOptions>> = {
  poster: { weekday: 'short', day: 'numeric', month: 'short' },
  corporate: { weekday: 'long', day: 'numeric', month: 'long' },
};

const UNUSED: Record<Look, string> = {
  pop: '.kicker, .live, .date, .for, .until, .rule, .head',
  poster: '.kicker, .live, .for, .until, .pin',
  night: '.kicker, .date, .rule, .head, .pin, .for .k',
  corporate: '.live, .until, .pin',
};

/** Lists draw the day as rows of bookings, timelines as blocks along the hours. */
const TIMELINE: Record<Look, boolean> = { pop: false, poster: true, night: true, corporate: false };

/** The play's clock, and the moment the status counts down to (the next meeting, or the end of this one). */
let timer = 0;
let target: Date | undefined;

const span = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} hr${m ? ` ${m} min` : ''}` : `${m} min`;
};

/** Text that follows the time: the clock and how long is left. It changes once a minute; a tick only writes what changed. */
function render(ctx: TemplateContext): void {
  const now = clockNow();
  const set = (sel: string, text: string) => {
    const el = document.querySelector(sel);
    if (el && el.textContent !== text) el.textContent = text;
  };
  const parts = formatter(ctx, { hour: 'numeric', minute: '2-digit', hourCycle: ctx.data.hour24 ? 'h23' : 'h12' }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  set('.hh', part('hour'));
  set('.mm', part('minute'));
  set('.ap', part('dayPeriod') && ` ${part('dayPeriod')}`);
  const date = DATES[LOOKS.find((l) => l === ctx.data.look)!];
  set('.date', date ? formatter(ctx, date).format(now) : '');
  if (target) set('.for .v', span(Math.max(1, Math.ceil((target.getTime() - now.getTime()) / MINUTE))));
}

defineTemplate({
  async prepare(ctx) {
    await applyLook(ctx);
    const { data } = ctx;
    const look = LOOKS.find((l) => l === data.look)!;
    // Parts a look does not draw are removed, not hidden, so no text is left for a screen reader to
    // read out or for the layout to make room for.
    for (const part of document.querySelectorAll(UNUSED[look])) part.remove();
    const now = clockNow();
    const today = dayKey(ctx, now);
    const time = formatter(ctx, { hour: 'numeric', minute: '2-digit', hourCycle: data.hour24 ? 'h23' : 'h12' });
    const at = (d: Date) => time.format(d);

    // The player has checked the rows against the field; a typed fallback row may still hold a time
    // that does not parse, which no feed writes, and is left out.
    const bookings: Booking[] = Array.isArray(data.events) ? data.events : [];
    const day: Meeting[] = bookings
      .filter((b) => !b.allDay)
      .map((b) => ({ title: b.title, organizer: b.organizer, start: new Date(b.start), end: new Date(b.end || b.start) }))
      .filter((m) => m.end >= m.start && dayKey(ctx, m.start) <= today && dayKey(ctx, new Date(m.end.getTime() - 1)) >= today)
      .sort((a, b) => a.start.getTime() - b.start.getTime());
    // An all-day event's end date is exclusive. It is noted, not counted as a booking: on a room's
    // calendar it is as often a note (a holiday, cleaning) as a booking.
    const allDay = bookings.filter((b) => b.allDay && b.start.slice(0, 10) <= today && (b.end ? b.end.slice(0, 10) > today : b.start.slice(0, 10) === today));
    const el = (sel: string) => document.querySelector<HTMLElement>(sel);
    const drop = (sel: string) => el(sel)?.remove();
    // Switched off, or not drawn in this look.
    const put = (sel: string, text: string) => {
      const target = el(sel);
      if (target) target.textContent = text;
    };
    const remaining = day.filter((m) => m.end > now);
    const current = remaining.find((m) => m.start <= now);
    const next = remaining.find((m) => m.start > now);
    el('.stage')!.dataset.state = current ? 'busy' : 'free';
    // Busy until the last of the meetings that follow on (or overlap) without a gap.
    let freeAt = current?.end;
    while (freeAt) {
      const end = freeAt;
      const follows = remaining.find((m) => m.start <= end && m.end > end);
      if (!follows) break;
      freeAt = follows.end;
    }
    target = freeAt ?? next?.start;

    el('.word')!.textContent = WORDS[look][current ? 1 : 0];
    put('.seats .v', String(data.seats));
    put('.seats .k', data.seats === 1 ? ' seat' : ' seats');
    if (data.floor) put('.floor .v', String(data.floor));
    else drop('.floor');

    // The line under the status, in each look's words: free until when and what then, or the meeting
    // on now. The time comes first, so a long title cut by the clamp never takes it with it.
    const line = el('.line')!;
    const say = (kick: string, title: string) => {
      if (kick) line.append(Object.assign(document.createElement('span'), { className: 'kick', textContent: kick }));
      if (title) line.append(Object.assign(document.createElement('span'), { className: 'title', textContent: title }));
    };
    if (current) {
      const until = at(current.end);
      say(look === 'poster' ? `Now, until ${until}` : look === 'night' ? '' : `Until ${until} · `, current.title);
      put('.for .k', 'Time left');
      put('.until', `left, until ${at(freeAt!)}`);
    } else if (next) {
      const until = at(next.start);
      const then = data.showNext ? next.title : '';
      if (look === 'night') say(then && `Next at ${until}: `, then);
      else say(`${look === 'pop' ? 'Grab it' : 'Free'} until ${until}${then && ', then '}`, then);
      put('.for .k', 'Free for');
      put('.until', `until ${until}`);
    } else {
      say(day.length ? 'Nothing else booked today' : 'Nothing booked today', '');
      drop('.for');
      drop('.until');
    }
    if (!line.childElementCount) line.remove();
    if (current?.organizer) put('.org', `Booked by ${current.organizer}`);
    else drop('.org');
    const after = current && remaining.find((m) => m.start >= current.end && m !== current);
    if (after) put('.next', `Next at ${at(after.start)}: ${after.title}`);
    else drop('.next');

    const schedule = el('.schedule');
    if (allDay.length) put('.allday', `All day: ${allDay.map((b) => b.title).join(' · ')}`);
    else drop('.allday');
    if (schedule && !remaining.length) {
      el('.free-day')!.textContent = day.length ? 'Free for the rest of the day' : 'Free all day';
      drop('.items');
      drop('.pin');
      drop('.track');
    } else if (schedule) {
      drop('.free-day');
      if (TIMELINE[look]) timeline(ctx, day, now, at);
      else list(look, day, now, current, at, Boolean(data.showNowLine));
    }
    render(ctx);
    inkCards();
    fitWord(el('.word')!);
  },
  play(ctx) {
    // Wake on each second boundary; text only changes when the minute does.
    const tick = () => {
      render(ctx);
      timer = window.setTimeout(tick, 1000 - (clockNow().getTime() % 1000) + 5);
    };
    tick();
  },
  stop() {
    clearTimeout(timer);
    target = undefined;
  },
});

/** Rows of the day's bookings (Pop's cards, Corporate's list), as many as fit, with the now line between or over them. */
function list(look: Look, day: Meeting[], now: Date, current: Meeting | undefined, at: (d: Date) => string, nowLine: boolean): void {
  const items = document.querySelector<HTMLElement>('.items')!;
  document.querySelector('.track')?.remove();
  const row = document.querySelector<HTMLTemplateElement>('#item')!;
  day.forEach((m, i) => {
    const li = row.content.firstElementChild!.cloneNode(true);
    if (!(li instanceof HTMLElement)) return;
    li.style.setProperty('--lk-i', String(3 + Math.min(i, 5)));
    li.classList.toggle('past', m.end <= now);
    li.classList.toggle('current', m === current);
    li.querySelector('.when')!.textContent = look === 'pop' ? `${at(m.start)} – ${at(m.end)}` : at(m.start);
    li.querySelector('.what')!.textContent = m.title;
    if (look === 'corporate') li.querySelector('.sub')!.textContent = `Until ${at(m.end)}`;
    else li.querySelector('.sub')!.remove();
    // The meeting on now shows how far it has gone, which is the now line's place while the room is busy.
    if (m === current) li.style.setProperty('--progress', String((now.getTime() - m.start.getTime()) / (m.end.getTime() - m.start.getTime())));
    if (m !== current || !nowLine) li.querySelector('.bar')!.remove();
    items.append(li);
  });
  // Corporate's now line is a row of its own, before the next meeting; Pop's is a pin above the cards.
  const nextRow = [...items.children].find((li) => !li.classList.contains('past'));
  if (look === 'corporate' && nowLine && !current)
    items.insertBefore(document.querySelector<HTMLTemplateElement>('#now-row')!.content.cloneNode(true), nextRow ?? null);
  // As many rows as fit: drop meetings that are over first, then from the end.
  const across = getComputedStyle(items).flexDirection === 'row';
  const over = () => (across ? items.scrollWidth > items.clientWidth + 1 : items.scrollHeight > items.clientHeight + 1);
  while (over() && items.children.length > 1) (items.querySelector('.past') ?? items.lastElementChild!).remove();
  const pin = document.querySelector<HTMLElement>('.pin');
  if (pin) placePin(pin, items, across, current);
}

/**
 * Pop's pin above its cards (in portrait, beside them): over the meeting on now at the point it has
 * reached, or in the gap before the next one. Kept inside the row.
 */
function placePin(pin: HTMLElement, items: HTMLElement, across: boolean, current: Meeting | undefined): void {
  const cards = [...items.children].filter((c): c is HTMLElement => c instanceof HTMLElement);
  const startOf = (c: HTMLElement) => (across ? c.offsetLeft : c.offsetTop);
  const sizeOf = (c: HTMLElement) => (across ? c.offsetWidth : c.offsetHeight);
  const live = cards.find((c) => c.classList.contains('current'));
  const nextIndex = cards.findIndex((c) => !c.classList.contains('past'));
  let point: number;
  if (current && live) point = startOf(live) + Number(live.style.getPropertyValue('--progress')) * sizeOf(live);
  else if (nextIndex > 0) point = (startOf(cards[nextIndex - 1]!) + sizeOf(cards[nextIndex - 1]!) + startOf(cards[nextIndex]!)) / 2;
  else point = 0;
  const half = (across ? pin.offsetWidth : pin.offsetHeight) / 2;
  const length = across ? items.clientWidth : items.clientHeight;
  pin.style.setProperty('--pin', `${Math.min(Math.max(point, half), length - half)}px`);
}

/**
 * The day along its hours (Poster's column, Night's track): from 8 to 18 at least, longer to take in
 * the day's bookings and now. A block too small for its label shows only its colour.
 */
function timeline(ctx: TemplateContext, day: Meeting[], now: Date, at: (d: Date) => string): void {
  document.querySelector('.items')?.remove();
  document.querySelector('.pin')?.remove();
  const track = document.querySelector<HTMLElement>('.track')!;
  const today = dayKey(ctx, now);
  const clock = formatter(ctx, { hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  const hourOf = (d: Date) => {
    const key = dayKey(ctx, d);
    if (key < today) return 0;
    if (key > today) return 24;
    const p = clock.formatToParts(d);
    return (Number(p.find((x) => x.type === 'hour')?.value) % 24) + Number(p.find((x) => x.type === 'minute')?.value) / 60;
  };
  const nowH = hourOf(now);
  const from = Math.max(0, Math.floor(Math.min(8, nowH, ...day.map((m) => hourOf(m.start)))));
  const to = Math.min(24, Math.ceil(Math.max(18, nowH + 0.01, ...day.map((m) => hourOf(new Date(m.end.getTime() - 1))))));
  const frac = (h: number) => String((h - from) / (to - from));
  const hours = track.querySelector('.hours')!;
  const step = to - from > 12 ? 2 : 1;
  for (let h = from; h <= to; h += step) {
    const label = document.createElement('span');
    label.style.setProperty('--t', frac(h));
    label.textContent = ctx.data.hour24 ? String(h).padStart(2, '0') : String(((h + 11) % 12) + 1);
    hours.append(label);
  }
  track.style.setProperty('--now', frac(nowH));
  const tpl = document.querySelector<HTMLTemplateElement>('#block')!;
  let reached = 0;
  day.forEach((m, i) => {
    const block = tpl.content.firstElementChild!.cloneNode(true);
    if (!(block instanceof HTMLElement)) return;
    block.style.setProperty('--a', frac(hourOf(m.start)));
    block.style.setProperty('--b', frac(hourOf(new Date(m.end.getTime() - 1))));
    block.style.setProperty('--lk-i', String(3 + Math.min(i, 5)));
    block.classList.toggle('past', m.end <= now);
    block.classList.toggle('current', m.start <= now && m.end > now);
    block.querySelector('.when')!.textContent = at(m.start);
    block.querySelector('.what')!.textContent = m.title;
    // A double booking: a block that overlaps an earlier one shows only its colour, under the earlier
    // one's label, so no label lands on another or under another block.
    if (m.start.getTime() < reached) {
      block.replaceChildren();
      block.classList.add('under');
    }
    reached = Math.max(reached, m.end.getTime());
    track.append(block);
  });
  for (const block of track.querySelectorAll<HTMLElement>('.block')) {
    const what = block.querySelector<HTMLElement>('.what');
    // A block over an earlier one has no label left to fit.
    if (!what) continue;
    const em = Number.parseFloat(getComputedStyle(what).fontSize);
    if (block.scrollHeight > block.clientHeight + 1 || block.scrollWidth > block.clientWidth + 1 || what.clientWidth < 2.5 * em) block.replaceChildren();
  }
}

/**
 * Text on a card (a booking, the schedule's panel) in the colour the look asks for (`--ink`,
 * `--ink-muted`, `--ink-accent`) where that reads on the card, else black or white. Cards share a
 * few fills, so each is read once.
 */
function inkCards(): void {
  const seen = new Map<string, string[]>();
  for (const card of document.querySelectorAll<HTMLElement>('.card')) {
    const s = getComputedStyle(card);
    // A card that paints nothing (a row on Corporate's panel) keeps the inks of the card under it.
    if (s.backgroundColor === 'rgba(0, 0, 0, 0)') continue;
    const wants = ['--ink', '--ink-muted', '--ink-accent'].map((v) => s.getPropertyValue(v).trim());
    const key = `${s.backgroundColor} ${wants.join(' ')}`;
    if (!seen.has(key)) {
      const fill = painted(s.backgroundColor);
      seen.set(
        key,
        wants.map((ink) => readableOn(fill, ink)),
      );
    }
    const [text, muted, accent] = seen.get(key)!;
    card.style.setProperty('--card-text', text!);
    card.style.setProperty('--card-muted', muted!);
    card.style.setProperty('--card-accent', accent!);
  }
}

/** The status word at the look's size, or smaller where a long word ("Available") would run past its column. */
function fitWord(word: HTMLElement): void {
  if (word.scrollWidth <= word.clientWidth) return;
  const size = Number.parseFloat(getComputedStyle(word).fontSize);
  word.style.fontSize = `${Math.floor((size * word.clientWidth) / word.scrollWidth)}px`;
}
