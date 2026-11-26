import { applyLook, crawl, LOOKS } from '@signforge/template-looks';
import { now as clockNow, defineTemplate, fitWords, formatter, type TemplateContext } from '@signforge/template-sdk';
import { bindRow, rowImage } from '@signforge/template-sdk/rows';

type Look = (typeof LOOKS)[number];

/** A row of the `items` field, as the news feed (`NewsFeed`) writes it. */
interface Story {
  title: string;
  published: string;
  source: string;
  summary: string;
}

/** A story with a headline, and its row in `items`, which `bindRow` and `rowImage` read by. */
interface Listed {
  story: Story;
  row: number;
}

/** Between headlines in the crawl. */
const SEPARATORS: Record<Look, string> = { pop: '  ·  ', poster: '  —  ', night: '  /  ', corporate: '   ·   ' };

/** Stories in the list, which the lead rotates through: as many as fit each orientation's column at the look's row height. */
const LIST_ROWS = { landscape: 5, portrait: 4 } as const;

/** The lead headline at each step, from the look's own size down; past the last, a headline is cut to its lines (cuts begin at about 90 to 120 characters). */
const HEADLINE_STEPS = [1, 0.86, 0.74, 0.64];

/** How long the list's marker takes to slide to the next story, ending as that story comes on. */
const MARKER_MS = 600;

/** How long before its turn a later story's photo starts to load. */
const LOAD_AHEAD_MS = 3000;

/** The most a lead photo is drawn above its own size: past it, a feed's small photo looks soft (owner decision on #476). */
const MAX_UPSCALE = 1.25;
/** A smaller frame's share of the lead: its width beside the text in landscape, its height above it in portrait. */
const SMALL_SHARE = { landscape: 0.42, portrait: 0.55 } as const;

/**
 * The later stories' photos, each loaded in play a little before its turn rather than in prepare: the SDK decodes every
 * photo with a `src` before ready, and on the Pi four 1080p photos took a portrait prepare from about 460 to 600 ms
 * (spike/pi-perf/RESULTS.md, News 2.0). Timers of the play, cleared by the next prepare.
 */
let later: { story: HTMLElement; img: HTMLImageElement; row: number; at: number; title: string }[] = [];
let timers: number[] = [];

/** "33 minutes ago", "il y a 2 heures": the story's age in the feed's language. */
function ago(iso: string, now: Date, locale: string): string {
  const t = new Date(iso).getTime();
  if (!iso || Number.isNaN(t)) return '';
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const mins = Math.max(0, Math.round((now.getTime() - t) / 60000));
  if (mins < 60) return rtf.format(-mins, 'minute');
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? rtf.format(-hrs, 'hour') : rtf.format(-Math.round(hrs / 24), 'day');
}

/** A copy of a `<template>`'s element: a story layer or a list row. */
function clone(id: string): HTMLElement {
  const el = document.querySelector<HTMLTemplateElement>(`#${id}`)!.content.firstElementChild!.cloneNode(true);
  if (!(el instanceof HTMLElement)) throw new Error(`#${id} holds no element`);
  return el;
}

defineTemplate({
  async prepare(ctx) {
    const { data } = ctx;
    for (const t of timers) clearTimeout(t);
    timers = [];
    later = [];
    const look = LOOKS.find((l) => l === data.look)!;
    // Unpainted until play: a frame that paints a photo while prepare runs has it decoded for the
    // screen first, and the SDK's decode before ready waits behind that one (photo-promo, #168).
    const leads = document.getElementById('leads')!;
    leads.style.visibility = 'hidden';

    // The contract has checked the list against the field before a template sees it: the check here only tells TypeScript.
    const items: Story[] = Array.isArray(data.items) ? data.items : [];
    // A row without a headline is left out, and every story keeps its own row's photo.
    const all: Listed[] = items.flatMap((story, row) => (story.title.trim() ? [{ story, row }] : []));
    const listed = all.slice(0, LIST_ROWS[ctx.orientation]);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    // The lead turns every `rotationSeconds`, through the listed stories, each for an equal share of the play. Held still, it shows the first.
    const turns = reduced
      ? Math.min(1, listed.length)
      : Math.min(listed.length, Math.max(1, Math.round(ctx.durationMs / (Number(data.rotationSeconds) * 1000))));
    const photos = data.showImages === true && listed.some(({ row }) => rowImage(ctx, 'items', row, 'image'));

    const stories = Array.from({ length: Math.max(1, turns) }, () => clone('story'));
    leads.append(...stories);
    const rows = document.getElementById('rows')!;
    if (listed.length > 1) rows.append(...listed.map(() => clone('row')));
    // An element with nothing to show is off, as if switched off, so the layout closes up around it.
    await applyLook({
      ...ctx,
      data: { ...data, showImages: photos, showList: data.showList === true && listed.length > 1, showCrawl: data.showCrawl === true && all.length > 0 },
    });

    const credit = String(data.source || listed[0]?.story.source || '').trim();
    const creditEl = document.getElementById('credit')!;
    if (credit) creditEl.textContent = credit;
    else creditEl.remove();
    const now = clockNow();
    document.getElementById('clock')!.textContent = formatter(ctx, { hour: 'numeric', minute: '2-digit' }).format(now);
    const lang = String(data.language || ctx.locale);

    const slot = ctx.durationMs / stories.length;
    stories.forEach((el, i) => {
      // Each story comes on as the last goes, over it, and goes as the next comes; the last stays to the end of the play.
      el.style.zIndex = String(i);
      el.style.setProperty('--at', i ? `calc(${Math.round(i * slot)}ms - var(--lk-out))` : '0ms');
      if (i < stories.length - 1) el.style.setProperty('--until', `${Math.round((i + 1) * slot)}ms`);
      const entry = listed[i];
      if (!entry) {
        el.classList.add('empty', 'no-photo');
        el.querySelector('.headline')!.textContent = 'No headlines yet';
        for (const part of el.querySelectorAll('.media, .meta, .summary')) part.remove();
        return;
      }
      const { story, row } = entry;
      const photo = el.querySelector<HTMLImageElement>('.photo');
      if (i > 0) photo?.removeAttribute('data-sf-src');
      bindRow(el, ctx, 'items', row);
      const bare = () => {
        el.classList.add('no-photo');
        el.querySelector('.media')?.remove();
      };
      if (!photos || !photo || !rowImage(ctx, 'items', row, 'image')) bare();
      else {
        // A photo the browser cannot decode: bindRow hides it, and the story goes without a frame rather than show an empty one.
        const watch = new MutationObserver(() => {
          if (!photo.hidden) return;
          watch.disconnect();
          bare();
        });
        watch.observe(photo, { attributes: true, attributeFilter: ['hidden'] });
        if (i > 0) later.push({ story: el, img: photo, row, at: i * slot - LOAD_AHEAD_MS, title: story.title });
      }
      const meta = el.querySelector('.meta');
      if (meta) {
        const src = story.source || credit;
        const age = ago(story.published, now, lang);
        if (src) meta.querySelector('.src')!.textContent = src;
        else meta.querySelector('.src')!.remove();
        if (age) meta.querySelector('.age')!.textContent = age;
        else meta.querySelector('.age')!.remove();
        if (!src && !age) meta.remove();
      }
      if (!story.summary) el.querySelector('.summary')?.remove();
    });

    const listRows = [...rows.querySelectorAll<HTMLElement>(':scope > .row')];
    listRows.forEach((el, i) => {
      const { row } = listed[i]!;
      bindRow(el, ctx, 'items', row);
      const thumb = el.querySelector('.thumb');
      if (thumb && !rowImage(ctx, 'items', row, 'image', 'thumb')) {
        // Never an empty frame: the story's place in the list, 01 to 05. An initial repeated down the rows (every
        // Guardian story is "World news") read as a placeholder (owner decision on #476).
        thumb.classList.add('none');
        thumb.querySelector('img')!.remove();
        thumb.querySelector('.number')!.textContent = String(i + 1).padStart(2, '0');
      }
    });

    const strip = document.getElementById('crawl');
    if (strip) {
      strip.textContent = all.map(({ story }) => story.title.trim()).join(SEPARATORS[look]);
      crawl(strip, ctx);
    }

    // The first story's photo has its size once loaded: a small one gets a smaller frame before its headline is fitted.
    const first = stories[0]!.querySelector<HTMLImageElement>('.photo[src]');
    if (first) {
      const body = document.body;
      await loaded(first);
      // New data while it loaded: the SDK put a fresh document in place, which the next prepare fills.
      if (document.body !== body) throw new Error('new data replaced this prepare');
      frame(stories[0]!, first, ctx.orientation);
    }
    fitHeadlines(stories);
    if (rows.isConnected && listRows.length) mark(ctx, listRows, stories.length, slot);
  },
  play(ctx) {
    document.getElementById('leads')!.style.visibility = '';
    for (const { story, img, row, at, title } of later)
      timers.push(
        window.setTimeout(() => {
          img.dataset.sfSrc = 'image';
          bindRow(img, ctx, 'items', row);
          void loaded(img).then(() => {
            if (!frame(story, img, ctx.orientation)) return;
            story.style.removeProperty('--fit');
            // From the title, not the cut prepare made for the larger frame.
            story.querySelector('.headline')!.textContent = title;
            fitHeadlines([story]);
          });
        }, at),
      );
  },
});

/** Resolves once `img` has loaded, or failed to. */
const loaded = (img: HTMLImageElement) =>
  img.complete
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        img.addEventListener('load', () => resolve(), { once: true });
        img.addEventListener('error', () => resolve(), { once: true });
      });

/**
 * A photo the lead would draw more than MAX_UPSCALE times its own size: framed at that or less, beside the text in
 * landscape and above it in portrait, the text taking the rest (`.small`). Returns whether it did.
 */
function frame(story: HTMLElement, img: HTMLImageElement, orientation: 'landscape' | 'portrait'): boolean {
  const { naturalWidth: w, naturalHeight: h } = img;
  const lead = story.getBoundingClientRect();
  if (!w || !h || Math.max(lead.width / w, lead.height / h) <= MAX_UPSCALE) return false;
  const room =
    orientation === 'portrait' ? { w: lead.width, h: lead.height * SMALL_SHARE.portrait } : { w: lead.width * SMALL_SHARE.landscape, h: lead.height };
  const scale = Math.min(MAX_UPSCALE, room.w / w, room.h / h);
  story.classList.add('small');
  story.style.setProperty('--nw-photo-w', `${Math.floor(w * scale)}px`);
  story.style.setProperty('--nw-photo-h', `${Math.floor(h * scale)}px`);
  return true;
}

/**
 * Each lead headline at the largest step whose lines (the look's `--nw-lines`) hold it, cut on a word only at the
 * smallest. Every story is written before any is read, so each step, and the cut, costs one layout however many
 * stories there are. Fitted a story at a time, four headlines of about 120 characters took Poster's and Night's
 * landscape prepares on the Pi to 483-514 ms, up to 34 ms over 2.0.0's (review of #492).
 */
function fitHeadlines(stories: HTMLElement[]): void {
  const heads = stories.map((story) => story.querySelector<HTMLElement>('.headline')!);
  /** The height the look's lines give a headline. */
  const room = (h: HTMLElement) => {
    const s = getComputedStyle(h);
    return Number(s.getPropertyValue('--nw-lines')) * Number.parseFloat(s.lineHeight);
  };
  const over = (h: HTMLElement) => {
    if (h.offsetHeight > room(h) + 1) return true;
    const story = h.closest<HTMLElement>('.story')!;
    if (!story.classList.contains('small')) return false;
    const card = h.closest<HTMLElement>('.card')!;
    return card.offsetTop < -1 || card.offsetTop + card.offsetHeight > story.clientHeight + 1;
  };
  let long = heads.filter(over);
  for (const step of HEADLINE_STEPS.slice(1)) {
    if (!long.length) return;
    for (const h of long) h.closest<HTMLElement>('.story')!.style.setProperty('--fit', String(step));
    long = long.filter(over);
  }
  // Longer still: cut on a word, with "…", rather than clamped, which would clip the last line's descenders. Where
  // each word's line ends is read from the one layout there is; the cut is checked with one more.
  const full = long.map((h) => h.textContent!);
  // Read from the greedy layout: a balanced one spreads the words over the lines, and holds fewer than they can.
  for (const h of long) h.style.setProperty('text-wrap', 'wrap');
  const kept = long.map(wordsInRoom);
  long.forEach((h, i) => {
    h.style.removeProperty('text-wrap');
    h.textContent = fitWords(full[i]!, (text) => text.trim().split(/\s+/).length <= kept[i]!);
  });
  long.forEach((h, i) => {
    if (!over(h)) return;
    // The "…" took the last word to another line, or there is no space to cut on (a URL, or a script written
    // without them): searched with a layout a try, and between characters, so a headline never runs past its lines.
    const fits = (text: string) => {
      h.textContent = text;
      return !over(h);
    };
    h.textContent = fitWords(full[i]!, fits);
    if (over(h)) h.textContent = cutChars(full[i]!, fits);
  });

  /** How many of `h`'s words end within its lines, read from the layout it has (its only child is its text). */
  function wordsInRoom(h: HTMLElement): number {
    const text = h.firstChild!;
    const box = h.getBoundingClientRect();
    // The rects are as drawn, through the intro's transform at its start: measured as a share of the drawn height.
    const limit = box.top + ((room(h) + 1) * box.height) / h.offsetHeight;
    const range = document.createRange();
    let n = 0;
    for (const word of h.textContent!.matchAll(/\S+/g)) {
      range.setStart(text, word.index);
      range.setEnd(text, word.index + word[0].length);
      const r = range.getBoundingClientRect();
      // By the word's middle: set solid, a glyph box stands past its line's, and the last line would never count.
      if ((r.top + r.bottom) / 2 > limit) break;
      n++;
    }
    return n;
  }
}

/** The longest start of `text`, with "…", that `fits`: a search over its characters. */
function cutChars(text: string, fits: (candidate: string) => boolean): string {
  const chars = [...text];
  let lo = 0;
  let hi = chars.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(`${chars.slice(0, mid).join('')}…`)) lo = mid;
    else hi = mid - 1;
  }
  return `${chars.slice(0, lo).join('')}…`;
}

/**
 * The list's marker on the story the lead shows: at the first story from the start, sliding to each next one so that
 * it arrives as that story comes on. One transform animation the length of the play, which the SDK starts with the rest.
 */
function mark(ctx: TemplateContext, rows: HTMLElement[], turns: number, slot: number): void {
  const marker = document.querySelector<HTMLElement>('.marker')!;
  const at = (i: number) => `translateY(${rows[i]!.offsetTop}px)`;
  marker.style.height = `${rows[0]!.offsetHeight}px`;
  marker.style.transform = at(0);
  if (turns < 2) return;
  const d = ctx.durationMs;
  const frames: Keyframe[] = [{ offset: 0, transform: at(0) }];
  for (let i = 1; i < turns; i++) {
    const arrive = i * slot;
    frames.push({ offset: (arrive - MARKER_MS) / d, transform: at(i - 1), easing: 'cubic-bezier(0.3, 0, 0.2, 1)' }, { offset: arrive / d, transform: at(i) });
  }
  frames.push({ offset: 1, transform: at(turns - 1) });
  marker.animate(frames, { duration: d, fill: 'both' });
}
