import { applyLook, crawl, LOOKS } from '@signforge/template-looks';
import { now as clockNow, defineTemplate, formatter, type TemplateContext } from '@signforge/template-sdk';
import { wallTime } from '@signforge/template-sdk/wall-time';

type Look = (typeof LOOKS)[number];

interface Fact {
  label: string;
  value: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The `units` field's options, as how many units each shows. */
const UNITS: Record<string, number> = { days: 1, 'days and hours': 2, 'days, hours and minutes': 3 };
const UNIT_NAMES = ['Days', 'Hours', 'Minutes'];
/**
 * The run-ups a countdown's progress is drawn over: the shortest that holds the days to go. A
 * countdown has no start, so "Day 2 of 14" is its place in the last fortnight. Further off than a
 * year, it has no progress to show.
 */
const RUN_UPS = [7, 14, 30, 60, 90, 180, 365];
/** Pop's dots: one a day over a week or a fortnight, else each a share of the run-up. */
const MAX_DOTS = 14;
/** Night's ring fills in this long, after the figure has faded in. */
const SWEEP_S = 1.8;

/** The date line's weekday and month: Poster's sits in its header and Night's on a card. */
const DATE_STYLE: Record<Look, 'long' | 'short'> = { pop: 'long', poster: 'short', night: 'short', corporate: 'long' };

/** The title's size at each step, from the look's own down to where 60 characters fit its lines. */
const TITLE_STEPS = [1, 0.86, 0.74, 0.64, 0.56, 0.49];
/** The done text's, in the number's place. */
const DONE_STEPS = [1, 0.8, 0.64, 0.52, 0.42, 0.34];

/** The play's one timer, and what it writes when the count changes. */
let timer = 0;
let show: ((now: Date) => void) | undefined;

/** What the count shows at an instant: its units (days, hours, minutes), and whether a countdown has reached its target. */
interface Count {
  values: number[];
  done: boolean;
}

/**
 * The count at each instant, in the screen's zone. Days alone are calendar days, as people count
 * them: tomorrow is a day to go at any hour. With hours or minutes, it is the time between the two
 * wall clocks, so a day is always 24 hours, across a DST change too: 18:00 two days before an 18:00
 * target is 2 days and 0 hours. A countdown rounds up to its smallest unit and a count-up down, so
 * neither reaches a figure before its time. A countdown is done when the target's instant passes.
 */
function counter(ctx: TemplateContext, target: string, up: boolean, units: number): (now: Date) => Count {
  const clock = new Intl.DateTimeFormat('en-US', {
    timeZone: ctx.timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  /** The zone's wall clock at `t`, as milliseconds read as UTC. */
  const wall = (t: Date) => {
    const p = Object.fromEntries(clock.formatToParts(t).map((x) => [x.type, Number(x.value)]));
    return Date.UTC(p.year!, p.month! - 1, p.day, p.hour, p.minute, p.second);
  };
  const at = wallTime(ctx, target);
  const goal = wall(at);
  return (now) => {
    const from = wall(now);
    const done = !up && now.getTime() >= at.getTime();
    if (units === 1) {
      const days = Math.floor(goal / DAY) - Math.floor(from / DAY);
      return { values: [Math.max(0, up ? -days : days)], done };
    }
    const step = units === 2 ? HOUR : MINUTE;
    const span = up ? from - goal : goal - from;
    const ms = Math.max(0, (up ? Math.floor(span / step) : Math.ceil(span / step)) * step);
    return { values: [Math.floor(ms / DAY), Math.floor((ms % DAY) / HOUR), Math.floor((ms % HOUR) / MINUTE)].slice(0, units), done };
  };
}

defineTemplate({
  async prepare(ctx) {
    const { data } = ctx;
    const look = LOOKS.find((l) => l === data.look)!;
    const up = data.mode === 'up';
    const units = UNITS[String(data.units)]!;
    const target = String(data.target);
    const record = up ? Number(data.recordDays) : 0;
    const facts: Fact[] = Array.isArray(data.facts) ? data.facts : [];
    const now = clockNow();
    const at = wallTime(ctx, target);
    const count = counter(ctx, target, up, units);
    const first = count(now);
    // A countdown past its target shows the done text; with none, it stays at zero.
    const done = first.done && Boolean(data.doneText);
    // Whole calendar days, whatever the units, for the progress and the record.
    const days = units === 1 ? first.values[0]! : counter(ctx, target, up, 1)(now).values[0]!;

    const stage = document.querySelector<HTMLElement>('.stage')!;
    stage.append(document.querySelector<HTMLTemplateElement>(`#${look}`)!.content.cloneNode(true));
    stage.dataset.state = done ? 'done' : 'count';
    stage.dataset.units = String(units);
    stage.dataset.digits = String(Math.min(4, String(first.values[0]).length));
    const el = (sel: string) => document.querySelector<HTMLElement>(sel);
    const put = (sel: string, text: string) => {
      for (const e of document.querySelectorAll(sel)) e.textContent = text;
    };
    const drop = (sel: string) => {
      for (const e of document.querySelectorAll(sel)) e.remove();
    };
    const plural = (n: number, one: string, many: string) => `${n.toLocaleString(ctx.locale)} ${n === 1 ? one : many}`;

    // The date line, in the look's style; a target at midnight is a day, with no time.
    const year = (d: Date) => formatter(ctx, { year: 'numeric' }).format(d);
    const style = DATE_STYLE[look];
    const date = formatter(ctx, { weekday: style, day: 'numeric', month: style, ...(year(at) === year(now) ? {} : { year: 'numeric' }) }).format(at);
    const when = target.endsWith('T00:00') ? date : `${date} · ${formatter(ctx, { hour: 'numeric', minute: '2-digit' }).format(at)}`;

    // The progress: a countdown's place in its run-up, or a count-up's way to its record.
    const runUp = up ? undefined : RUN_UPS.find((w) => w >= days);
    const share = up ? (record ? Math.min(1, days / record) : undefined) : runUp && (runUp - days) / runUp;
    const beaten = days > record;
    const more = record + 1 - days;
    const toBeat = beaten ? 'A new record' : plural(more, 'more day', 'more days');
    const pct = share === undefined ? '' : `${Math.floor(share * 100)}%`;
    const progressLabel = up ? (beaten ? 'A new record' : `${pct} of the way to the record`) : `Day ${runUp! - days} of ${runUp}`;

    put('.title', String(data.title));
    put('.detail', up ? `Since ${when}` : when);
    put('.kicker', up ? 'Days since' : 'Countdown');
    put('.done', String(data.doneText));
    put('.best', `Best: ${plural(record, 'day', 'days')}`);
    put('.record .v', record.toLocaleString(ctx.locale));
    put('.record .s', beaten ? 'days, now beaten' : `days, ${more.toLocaleString(ctx.locale)} more to beat it`);

    // Night's and Corporate's facts start with the date and the record, then the spot's own.
    const factRow = document.querySelector<HTMLTemplateElement>('#fact')!.content.firstElementChild!;
    const list = el('.facts');
    const fact = (label: string, value: string, toggle: string) => {
      const row = factRow.cloneNode(true);
      if (!(row instanceof HTMLElement) || !list) return;
      row.dataset.show = toggle;
      row.querySelector('dt')!.textContent = label;
      row.querySelector('dd')!.textContent = value;
      row.style.setProperty('--lk-i', String(4 + list.childElementCount));
      list.append(row);
    };
    if (look === 'night') fact(up ? 'since' : 'when', when, 'detail');
    if (look === 'night' || look === 'corporate') {
      fact(look === 'night' ? 'record' : 'Record', plural(record, 'day', 'days'), 'record');
      fact(look === 'night' ? 'to beat it' : 'To beat it', toBeat, 'record');
    }
    if (look === 'poster') put('.band .lk-crawl', facts.map((f) => `${f.label}: ${f.value}`).join('  ·  '));
    else for (const f of facts) fact(f.label, f.value, 'facts');

    if (share !== undefined)
      progress(look, share, {
        label: progressLabel,
        dots: up ? MAX_DOTS : Math.min(runUp!, MAX_DOTS),
        from: up ? `${plural(days, 'day', 'days')} of ${record.toLocaleString(ctx.locale)}` : progressLabel,
        to: up ? 'Record' : date,
      });
    if (look === 'poster') tiles(units);

    // An element with nothing to show is off, as if switched off, so the layout closes up around it.
    const on = (toggle: string, has: unknown) => data[toggle] === true && Boolean(has);
    await applyLook({
      ...ctx,
      data: {
        ...data,
        // Poster's progress is its tiles' flip-clock split, which needs no share.
        showProgress: on('showProgress', (share !== undefined || look === 'poster') && !first.done),
        showRecord: on('showRecord', record),
        showFacts: on('showFacts', facts.length),
      },
    });
    if (done) drop('.number, .rest, .sticker:has(.unit), .unit-row, .tiles, .sub');
    else drop('.done, .done-box');
    if (units === 1) drop('.rest');
    if (list && !list.childElementCount) drop(look === 'corporate' ? '.foot' : '.facts');
    if (!data.title) drop('.title, .title-box');
    const band = el('.band .lk-crawl');
    if (band) crawl(band, ctx);

    // The figures that follow the time, written now and again by the timer whenever they change.
    const two = (n: number) => String(n).padStart(2, '0');
    show = (t: Date) => {
      const { values } = count(t);
      const set = (e: Element, text: string) => {
        if (e.textContent !== text) e.textContent = text;
      };
      const unit = `${values[0] === 1 ? 'day' : 'days'} ${up ? 'since' : 'to go'}`;
      for (const e of document.querySelectorAll('.number')) set(e, values[0]!.toLocaleString(ctx.locale));
      for (const e of document.querySelectorAll('.rest'))
        set(
          e,
          values
            .slice(1)
            .map((v, i) => `${two(v)} ${i ? 'min' : 'h'}`)
            .join(' '),
        );
      for (const e of document.querySelectorAll('.unit')) set(e, unit);
      const sub = [values[0] === 1 ? 'day' : 'days', ...values.slice(1).map((v, i) => `${two(v)}${i ? 'm' : 'h'}`)];
      for (const e of document.querySelectorAll('.sub')) set(e, [...sub, ...(el('.ring') ? [pct] : [])].join(' · '));
      document.querySelectorAll('.tile .v').forEach((e, i) => set(e, i ? two(values[i]!) : values[0]!.toLocaleString(ctx.locale)));
    };
    show(now);

    for (const figure of document.querySelectorAll<HTMLElement>('.number, .tile .v, .record .v')) shrink(figure);
    const doneText = el('.done');
    if (doneText) fit(doneText, DONE_STEPS, []);
    const boxes = [...document.querySelectorAll<HTMLElement>('.copy, .main')];
    const title = el('.title');
    if (title) fit(title, TITLE_STEPS, boxes);
    // Facts that still do not fit go, the spot's own first and from the end.
    const cards = () => [...document.querySelectorAll<HTMLElement>('.copy .fact')];
    while (boxes.some(overflows) && cards().length) (cards().findLast((c) => c.dataset.show === 'facts') ?? cards().at(-1)!).remove();
  },
  play() {
    // Wake on each second boundary; a figure only changes when its unit does.
    const tick = () => {
      show?.(clockNow());
      timer = window.setTimeout(tick, 1000 - (clockNow().getTime() % 1000) + 5);
    };
    tick();
  },
  stop() {
    clearTimeout(timer);
    show = undefined;
  },
});

/**
 * Each look's progress, at `share` of the way: Pop's `dots` and `label`, Night's ring, Corporate's
 * scale from `from` to `to`. Poster's is its tiles' split, a flip clock's, in the markup.
 */
function progress(look: Look, share: number, { label, dots: n, from, to }: { label: string; dots: number; from: string; to: string }): void {
  if (look === 'pop') {
    const dots = document.querySelector('.dots')!;
    const filled = Math.round(share * n);
    for (let i = 0; i < n; i++) {
      const dot = document.createElement('div');
      dot.className = 'dot-in lk-badge';
      dot.style.setProperty('--lk-i', String(MAX_DOTS + i));
      const inner = document.createElement('i');
      inner.className = `dot${i < filled ? ' on' : ''}${i === filled - 1 ? ' lk-pulse' : ''}`;
      dot.append(inner);
      dots.append(dot);
    }
    document.querySelector('.progress-label')!.textContent = label;
  } else if (look === 'night') {
    // Two half-discs, each turned inside its own half of the circle: transforms only, no stroke.
    const angle = share * 360;
    const right = Math.min(angle, 180);
    const t1 = angle ? (SWEEP_S * right) / angle : 0;
    const ring = document.querySelector<HTMLElement>('.ring')!;
    ring.style.setProperty('--a', `${angle}deg`);
    ring.style.setProperty('--a1', `${right}deg`);
    ring.style.setProperty('--a2', `${angle - right}deg`);
    ring.style.setProperty('--t', `${angle ? SWEEP_S : 0}s`);
    ring.style.setProperty('--t1', `${t1}s`);
    ring.style.setProperty('--t2', `${angle ? SWEEP_S - t1 : 0}s`);
  } else if (look === 'corporate') {
    const scale = document.querySelector<HTMLElement>('.scale')!;
    scale.style.setProperty('--share', String(share));
    scale.querySelector('.from')!.textContent = from;
    scale.querySelector('.to')!.textContent = to;
  }
}

/** Poster's tiles, one a unit. */
function tiles(units: number): void {
  const row = document.querySelector<HTMLTemplateElement>('#poster-tile')!.content.firstElementChild!;
  const box = document.querySelector('.tiles')!;
  for (let i = 0; i < units; i++) {
    const tile = row.cloneNode(true);
    if (!(tile instanceof HTMLElement)) continue;
    tile.style.setProperty('--lk-i', String(3 + i));
    tile.querySelector('.n')!.textContent = UNIT_NAMES[i]!;
    box.append(tile);
  }
}

/** A figure at its look's size, or smaller where it would run past the box it sits in (a count of five digits). */
function shrink(figure: HTMLElement): void {
  const box = figure.closest('.disc, .centre, .tile, .record, .figure')!;
  const s = getComputedStyle(box);
  const inner = (size: number, a: string, b: string) => size - Number.parseFloat(a) - Number.parseFloat(b);
  const over = Math.max(
    figure.scrollWidth / inner(box.clientWidth, s.paddingLeft, s.paddingRight),
    figure.offsetHeight / inner(box.clientHeight, s.paddingTop, s.paddingBottom),
  );
  if (over <= 1) return;
  const size = Number.parseFloat(getComputedStyle(figure).fontSize);
  figure.style.fontSize = `${Math.floor(size / over)}px`;
}

/** Whether anything in `box` falls below its content box, by layout: the intros' transforms are not where the copy rests. */
function overflows(box: HTMLElement): boolean {
  const limit = box.clientHeight - Number.parseFloat(getComputedStyle(box).paddingBottom) + 1;
  return [...box.children].some((c) => c instanceof HTMLElement && c.offsetTop + c.offsetHeight + Number.parseFloat(getComputedStyle(c).marginBottom) > limit);
}

/**
 * The largest step (`--fit` on `el`) at which `el` shows all its lines and nothing falls out of
 * `boxes`; at the smallest, the clamp's ellipsis ends it. Short copy takes one layout, anything
 * else a binary search of the rest.
 */
function fit(el: HTMLElement, steps: number[], boxes: HTMLElement[]): void {
  // Glyphs overhang a tight leading by a few pixels; clamped text hides at least a line.
  const clamped = () => el.scrollHeight - el.clientHeight > Number.parseFloat(getComputedStyle(el).fontSize) / 2;
  const set = (k: number) => el.style.setProperty('--fit', String(steps[k]));
  const fits = (k: number) => (set(k), !clamped() && !boxes.some(overflows));
  if (fits(0)) return;
  let [lo, hi] = [1, steps.length - 1];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (fits(mid)) hi = mid;
    else lo = mid + 1;
  }
  set(lo);
}
