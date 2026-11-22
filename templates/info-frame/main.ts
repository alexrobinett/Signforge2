import { applyLook, crawl, LOOKS } from '@signforge/template-looks';
import { BRAND_LOGO, dayKey, defineTemplate, formatter, now as clockNow, type TemplateContext } from '@signforge/template-sdk';
import { readableOn } from '@signforge/template-sdk/contrast';

type Look = (typeof LOOKS)[number];

/** A row of the `items` field, as the news feed (`NewsFeed`) writes it. */
interface Headline {
  title: string;
}

type Sky = 'clear' | 'partly' | 'cloudy' | 'fog' | 'rain' | 'snow' | 'storm';

/** WMO weather interpretation codes, as Open-Meteo sends them (templates/weather). */
function describe(code: number): { sky: Sky; label: string } {
  if (code === 0) return { sky: 'clear', label: 'Clear' };
  if (code === 1) return { sky: 'partly', label: 'Mostly clear' };
  if (code === 2) return { sky: 'partly', label: 'Partly cloudy' };
  if (code === 3) return { sky: 'cloudy', label: 'Overcast' };
  if (code === 45 || code === 48) return { sky: 'fog', label: 'Fog' };
  if (code >= 51 && code <= 57) return { sky: 'rain', label: 'Drizzle' };
  if (code >= 61 && code <= 67) return { sky: 'rain', label: 'Rain' };
  if (code >= 71 && code <= 77) return { sky: 'snow', label: 'Snow' };
  if (code >= 80 && code <= 82) return { sky: 'rain', label: 'Showers' };
  if (code === 85 || code === 86) return { sky: 'snow', label: 'Snow showers' };
  if (code >= 95) return { sky: 'storm', label: 'Thunderstorm' };
  return { sky: 'cloudy', label: 'Cloudy' };
}

/** A cloud over the lower part of the glyph, and what falls from it. Strokes in the text's colour; drawn once, never animated (#96). */
const CLOUD = '<path d="M7 16h10a4 4 0 0 0 0-8 6 6 0 0 0-11.6 1.8A3.2 3.2 0 0 0 7 16z"/>';
const GLYPHS: Record<Sky | 'moon' | 'night-partly', string> = {
  clear:
    '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M19.5 14.5A8 8 0 1 1 9.5 4.5a6.2 6.2 0 0 0 10 10z"/>',
  partly:
    '<circle cx="9" cy="9" r="3.5"/><path d="M9 2.5v1.5M3.5 9H2M4.6 4.6l1 1M13.4 4.6l-1 1"/><path d="M8 20h9a3.5 3.5 0 0 0 0-7 5 5 0 0 0-9.6 1.5A3 3 0 0 0 8 20z"/>',
  'night-partly': '<path d="M11.5 4.2A4.2 4.2 0 1 1 5 9.6a3.3 3.3 0 0 0 6.5-5.4z"/><path d="M8 20h9a3.5 3.5 0 0 0 0-7 5 5 0 0 0-9.6 1.5A3 3 0 0 0 8 20z"/>',
  cloudy: '<path d="M7 19h10a4 4 0 0 0 0-8 6 6 0 0 0-11.6 1.8A3.2 3.2 0 0 0 7 19z"/>',
  fog: `${CLOUD}<path d="M4 19.5h16M7 22h10"/>`,
  rain: `${CLOUD}<path d="M8.5 18.5l-1 2.5M12.5 18.5l-1 2.5M16.5 18.5l-1 2.5"/>`,
  snow: `${CLOUD}<path d="M8 19.5v.01M12 21.5v.01M16 19.5v.01M10 22v.01M14 22v.01"/>`,
  storm: `${CLOUD}<path d="M13 16.5l-2.5 3.5h3l-2.5 3.5"/>`,
};

/** Parts a look does not draw, removed rather than hidden: no text is left for a screen reader or for the layout to make room for. */
const UNUSED: Record<Look, string> = {
  pop: '.seconds, .clock-rule, .weather-rule, .eyebrow, .live, .cond, .sky, .ap',
  poster: '.seconds, .weather-rule, .glyph, .place, .live, .price-in, .lo, .ap',
  night: '.clock-rule, .weather-rule, .forecast-rule, .eyebrow, .now .cond, .chip .glyph, .sky, .lo, .ap',
  corporate: '.seconds, .clock-rule, .forecast-rule, .eyebrow, .live, .cond, .sky',
};

/** The date over or under the clock, in each look's words. */
const DATES: Record<Look, Intl.DateTimeFormatOptions> = {
  pop: { weekday: 'long', day: 'numeric', month: 'long' },
  poster: { weekday: 'long', day: 'numeric', month: 'short' },
  night: { weekday: 'short', day: 'numeric', month: 'short' },
  corporate: { weekday: 'long', day: 'numeric', month: 'long' },
};

/** Between headlines in the crawl. */
const SEPARATORS: Record<Look, string> = { pop: '  ·  ', poster: '  —  ', night: '  /  ', corporate: '   ·   ' };

/** The crawl's speed as a share of the look's own. */
const SPEEDS: Record<string, number> = { slow: 0.7, normal: 1, fast: 1.4 };

/** The caption's title at each step, from the look's own size down to where 64 characters fit its two lines. */
const TITLE_STEPS = [1, 0.86, 0.74, 0.64];

/** The text that follows the time, written by the play's clock; cleared in `stop`. */
let show: ((t: Date) => void) | undefined;
let timer = 0;

defineTemplate({
  async prepare(ctx) {
    const { data, assets, root } = ctx;
    const look = LOOKS.find((l) => l === data.look)!;
    const stage = document.querySelector<HTMLElement>('.stage')!;
    // Unpainted until play: a frame that paints the photo, on a layer of its own while it drifts,
    // has it decoded for the screen first, and the SDK's decode before ready then waits behind that
    // one (photo-promo, #168; Announcement, #197). Every look's panel comes in from nothing (Poster's
    // under its ink block), so no frame shows the change.
    const photo = document.querySelector<HTMLElement>('.photo')!;
    photo.style.visibility = 'hidden';

    // The contract has checked the list against the field before a template sees it: the check here only tells TypeScript.
    const items: Headline[] = Array.isArray(data.items) ? data.items : [];
    const headlines = items.map((h) => h.title.trim()).filter(Boolean);
    const clock = data.showClock === true;
    const weather = data.showWeather === true;
    // A rail holding only the logo would waste a column: without the clock and the weather there is none.
    const rail = data.rail !== 'off' && (clock || weather);
    const ticker = data.ticker !== 'off' && headlines.length > 0;
    root.dataset.rail = rail ? String(data.rail) : 'off';
    root.dataset.ticker = ticker ? String(data.ticker) : 'off';
    // An element with nothing to show is off, as if switched off, so the layout closes up around it.
    const on = (toggle: string, has: unknown) => data[toggle] === true && Boolean(has);
    await applyLook({
      ...ctx,
      data: {
        ...data,
        showForecast: weather && data.showForecast === true,
        showCaption: on('showCaption', data.captionTitle || data.captionLine || data.price),
        showLogo: on('showLogo', assets[BRAND_LOGO]),
        showPrice: Boolean(data.price),
      },
    });
    // A reset while the look's faces loaded has put the next init's document in place: leave it be.
    if (!stage.isConnected) return;

    const drop = (sel: string) => {
      for (const el of document.querySelectorAll(sel)) el.remove();
    };
    drop(UNUSED[look]);
    // With a rail, the clock, the weather and the logo are in it; without one, the clock and the
    // weather are a chip on the photo, and the logo is on the photo too.
    drop(rail ? '.chip, .corner-logo' : '.rail');
    if (!clock && !weather) drop('.chip');
    if (!ticker) drop('.ticker');
    for (const el of document.querySelectorAll('[data-sf="captionTitle"], [data-sf="captionLine"]')) if (!el.textContent) el.remove();

    // The weather, now and for the next three days, in the screen's locale.
    const n = (k: string) => Math.round(Number(data[k]));
    const { sky, label } = describe(n('code'));
    const night = n('isDay') === 0;
    const glyph = night && sky === 'clear' ? 'moon' : night && sky === 'partly' ? 'night-partly' : sky;
    const words = night && sky === 'clear' ? 'Clear night' : label;
    for (const el of document.querySelectorAll('.glyph'))
      el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPHS[glyph]}</svg>`;
    for (const el of document.querySelectorAll('.temp-now')) el.textContent = `${n('temp')}°`;
    for (const el of document.querySelectorAll('.cond')) el.textContent = words;
    const [hi, lo, city] = [n('high'), n('low'), String(data.city)];
    // No-break spaces keep each figure with its word when the line wraps.
    const line = {
      pop: `${words} · H\u00a0${hi}° L\u00a0${lo}°`,
      poster: [`High\u00a0${hi}°`, `low\u00a0${lo}°`, city].filter(Boolean).join(' · '),
      night: `${words} · h${hi}\u00a0l${lo}`,
      corporate: `${words} · High\u00a0${hi}° · Low\u00a0${lo}°`,
    }[look];
    document.querySelector('.wline')?.replaceChildren(line);
    document.querySelector('.eyebrow')?.replaceChildren(String(data.price));
    if (!city) drop('.place');
    const days = document.querySelector('.days');
    if (days) forecast(ctx, look, days);

    // The crawl: every headline, twice over, sliding at the look's speed times the spot's.
    const strip = document.querySelector<HTMLElement>('.lk-crawl');
    if (strip) {
      strip.textContent = headlines.join(SEPARATORS[look]);
      const speed = Number.parseFloat(getComputedStyle(strip).getPropertyValue('--lk-crawl-speed'));
      strip.style.setProperty('--lk-crawl-speed', `${speed * SPEEDS[String(data.crawlSpeed)]!}vmin`);
      crawl(strip, ctx);
    }

    const time = formatter(ctx, { hour: look === 'night' && data.hour24 ? '2-digit' : 'numeric', minute: '2-digit', hourCycle: data.hour24 ? 'h23' : 'h12' });
    const date = formatter(ctx, DATES[look]);
    show = (t) => {
      const parts = time.formatToParts(t);
      const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
      const set = (sel: string, text: string) => {
        for (const el of document.querySelectorAll(sel)) if (el.textContent !== text) el.textContent = text;
      };
      set('.hh', part('hour'));
      set('.mm', part('minute'));
      set('.ap', part('dayPeriod'));
      set('.date', date.format(t));
    };
    // The clock sized at its widest, so a minute that adds a digit never runs past its box.
    const now = clockNow();
    show(now);
    for (const el of document.querySelectorAll('.hh, .mm')) el.textContent = '00';
    for (const el of document.querySelectorAll<HTMLElement>('.rail-time, .now')) shrink(el);
    show(now);

    const caption = document.querySelector<HTMLElement>('.caption');
    const title = document.querySelector<HTMLElement>('.title');
    if (caption && title) fitTitle(caption, title);
    inkCards();
  },
  play({ root }) {
    document.querySelector<HTMLElement>('.photo')!.style.visibility = '';
    // The colon blinks with the seconds and Night's bar fills with the minute: each animation put at
    // the screen's time once, then left to the compositor. Held still (portrait), the bar shows the
    // second the spot came on.
    const t = clockNow().getTime();
    root.style.setProperty('--if-second', String((t % 60_000) / 60_000));
    for (const a of document.querySelector('.tick-bar')?.getAnimations() ?? []) a.currentTime = t % 60_000;
    for (const el of document.querySelectorAll('.colon')) for (const a of el.getAnimations()) a.currentTime = t % 1000;
    // Wake on each second boundary; text only changes when the minute does.
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

/** A weekday formatter in `zone`, or the screen's zone if `zone` is empty or not an IANA name. */
function weekdayFormatter(ctx: TemplateContext, zone: string): Intl.DateTimeFormat {
  if (zone) {
    try {
      return new Intl.DateTimeFormat(ctx.locale, { weekday: 'short', timeZone: zone });
    } catch {
      // Unrecognised time zone in a manual fallback: use the screen's zone.
    }
  }
  return formatter(ctx, { weekday: 'short' });
}

/**
 * The next three days, each named from its live Open-Meteo timestamp (`daily.time.1`–`.3`) in the
 * feed's own time zone so cross-timezone screens and snapshots cached across midnight keep every
 * temperature under its own weekday. Static fallbacks (`0`) name the next three days from the
 * screen's today.
 */
function forecast(ctx: TemplateContext, look: Look, days: Element): void {
  const row = document.querySelector<HTMLTemplateElement>('#day')!.content.firstElementChild!;
  const [y, m, d] = dayKey(ctx, clockNow()).split('-').map(Number);
  const utcDay = new Intl.DateTimeFormat(ctx.locale, { weekday: 'short', timeZone: 'UTC' });
  const liveDay = weekdayFormatter(ctx, String(ctx.data.weatherTimezone ?? '').trim());
  for (const i of [1, 2, 3]) {
    const day = row.cloneNode(true);
    if (!(day instanceof HTMLElement)) continue;
    const n = (k: string) => Math.round(Number(ctx.data[`day${i}${k}`]));
    const unix = Number(ctx.data[`day${i}Time`]);
    day.style.setProperty('--lk-i', String(5 + i));
    day.querySelector('.dname')!.textContent =
      Number.isFinite(unix) && unix > 0 ? liveDay.format(new Date(unix * 1000)) : utcDay.format(new Date(Date.UTC(y!, m! - 1, d! + i, 12)));
    day.querySelector('.hi')!.textContent = look === 'poster' ? `${n('High')}° / ${n('Low')}°` : `${n('High')}°`;
    const lo = day.querySelector('.lo');
    if (lo) lo.textContent = `${n('Low')}°`;
    const sky = day.querySelector('.sky');
    if (sky) sky.textContent = describe(n('Code')).label;
    days.append(day);
  }
  // Parts this look does not draw, as in prepare.
  for (const el of days.querySelectorAll(UNUSED[look])) el.remove();
}

/**
 * A figure (the clock, the temperature) at its look's size, or smaller where it would run past its
 * box. Measures subpixel child edges as well as `scrollWidth` and leaves a small margin when
 * shrinking so tighter Linux font metrics never clip against `.lk-mask`.
 */
function shrink(el: HTMLElement): void {
  for (let i = 0; i < 6; i++) {
    const box = el.getBoundingClientRect();
    const childRight = Math.max(0, ...[...el.children].map((c) => c.getBoundingClientRect().right - box.left));
    const right = Math.max(childRight, el.scrollWidth > el.clientWidth ? el.scrollWidth : 0);
    if (right <= box.width - 0.5) return;
    const fit = Number(el.style.getPropertyValue('--if-fit') || 1);
    el.style.setProperty('--if-fit', ((fit * Math.max(1, box.width - 4)) / right).toFixed(3));
  }
}

/**
 * The caption's title at the largest step whose two lines hold it without horizontal overflow, so
 * long copy — including an unbroken 64-character word — wraps and ends in the clamp's ellipsis only
 * at the smallest step. A clamped line runs a whole line past the box; display type set solid only
 * runs its glyphs' overhang past it.
 */
function fitTitle(caption: HTMLElement, title: HTMLElement): void {
  for (const step of TITLE_STEPS) {
    caption.style.setProperty('--if-title-fit', String(step));
    if (title.scrollHeight <= title.clientHeight + Number.parseFloat(getComputedStyle(title).fontSize) / 2 && title.scrollWidth <= title.clientWidth + 1)
      return;
  }
}

/**
 * Text on a card (the rail, the caption, the chip, the ticker) in the colour the look asks for
 * (`--ink`, `--ink-muted`, `--ink-accent`, `--ink-primary`) where that reads on the card, else
 * black or white, as `--card-text`, `--card-muted`, `--card-accent` and `--card-primary`. An ink
 * may be a mix of tokens: probes resolve every ink at once, in one style pass, and the computed
 * colours are read as they are, with no canvas: on the Pi each forced style pass and each canvas
 * read cost a prepare milliseconds. Every card's fill is opaque.
 */
function inkCards(): void {
  const wants = [
    ['--ink', '--card-text'],
    ['--ink-muted', '--card-muted'],
    ['--ink-accent', '--card-accent'],
    ['--ink-primary', '--card-primary'],
  ] as const;
  const cards = [...document.querySelectorAll<HTMLElement>('.card')].flatMap((card) => {
    const s = getComputedStyle(card);
    // A card that paints nothing keeps the inks of the card under it.
    return s.backgroundColor === 'rgba(0, 0, 0, 0)' ? [] : [{ card, fill: s.backgroundColor, asked: wants.map(([ink]) => s.getPropertyValue(ink).trim()) }];
  });
  const probes = new Map([...new Set(cards.flatMap((c) => c.asked))].map((ink) => [ink, document.createElement('i')]));
  for (const [ink, probe] of probes) probe.style.color = ink;
  document.body.append(...probes.values());
  const hex = (computed: string) => {
    const [r = 0, g = 0, b = 0] = (computed.match(/[\d.]+/g) ?? []).map((v) => (computed.startsWith('color(') ? Number(v) * 255 : Number(v)));
    return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  };
  const resolved = new Map([...probes].map(([ink, probe]) => [ink, hex(getComputedStyle(probe).color)]));
  for (const probe of probes.values()) probe.remove();
  for (const { card, fill, asked } of cards) asked.forEach((ink, i) => card.style.setProperty(wants[i]![1], readableOn(hex(fill), resolved.get(ink)!)));
}
