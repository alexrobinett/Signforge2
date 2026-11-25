import { applyLook, crawl, LOOKS } from '@signforge/template-looks';
import { now as clockNow, defineTemplate, formatter, type TemplateContext } from '@signforge/template-sdk';
import { bindRow, rowImage } from '@signforge/template-sdk/rows';

type Look = (typeof LOOKS)[number];

/** A row of the `items` field, as the news feed (`NewsFeed`) writes it. */
interface Story {
  title: string;
  published: string;
  source: string;
  summary: string;
}

/** Between headlines in the crawl. */
const SEPARATORS: Record<Look, string> = { pop: '  ·  ', poster: '  —  ', night: '  /  ', corporate: '   ·   ' };

/** Stories in the list, which the lead rotates through: as many as fit each orientation's column at the look's row height. */
const LIST_ROWS = { landscape: 5, portrait: 4 } as const;

/** The lead headline at each step, from the look's own size down to where 200 characters fit its lines. */
const HEADLINE_STEPS = [1, 0.86, 0.74, 0.64];

/** How long the list's marker takes to slide to the next story, ending as that story comes on. */
const MARKER_MS = 600;

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
    const look = LOOKS.find((l) => l === data.look)!;
    // Unpainted until play: a frame that paints a photo while prepare runs has it decoded for the
    // screen first, and the SDK's decode before ready waits behind that one (photo-promo, #168).
    const leads = document.getElementById('leads')!;
    leads.style.visibility = 'hidden';

    // The contract has checked the list against the field before a template sees it: the check here only tells TypeScript.
    const all: Story[] = (Array.isArray(data.items) ? data.items : []).filter((s: Story) => s.title.trim());
    const listed = all.slice(0, LIST_ROWS[ctx.orientation]);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    // The lead turns every `rotationSeconds`, through the listed stories, each for an equal share of the play. Held still, it shows the first.
    const turns = reduced
      ? Math.min(1, listed.length)
      : Math.min(listed.length, Math.max(1, Math.round(ctx.durationMs / (Number(data.rotationSeconds) * 1000))));
    const photos = data.showImages === true && listed.some((_, i) => rowImage(ctx, 'items', i, 'image'));

    const stories = Array.from({ length: Math.max(1, turns) }, () => clone('story'));
    leads.append(...stories);
    const rows = document.getElementById('rows')!;
    if (listed.length > 1) rows.append(...listed.map(() => clone('row')));
    // An element with nothing to show is off, as if switched off, so the layout closes up around it.
    await applyLook({
      ...ctx,
      data: { ...data, showImages: photos, showList: data.showList === true && listed.length > 1, showCrawl: data.showCrawl === true && all.length > 0 },
    });

    const credit = String(data.source || listed[0]?.source || '');
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
      if (!listed[i]) {
        el.classList.add('empty', 'no-photo');
        el.querySelector('.headline')!.textContent = 'No headlines yet';
        for (const part of el.querySelectorAll('.media, .meta, .summary')) part.remove();
        return;
      }
      bindRow(el, ctx, 'items', i);
      if (!photos || !rowImage(ctx, 'items', i, 'image')) {
        el.classList.add('no-photo');
        el.querySelector('.media')?.remove();
      }
      const story = listed[i]!;
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
    listRows.forEach((row, i) => {
      bindRow(row, ctx, 'items', i);
      const thumb = row.querySelector('.thumb');
      if (thumb && !rowImage(ctx, 'items', i, 'image', 'thumb')) {
        // Never an empty frame: the story's source, or the feed's, by its first letter.
        thumb.classList.add('none');
        thumb.querySelector('img')!.remove();
        thumb.querySelector('.initial')!.textContent = [...(listed[i]!.source || credit || listed[i]!.title).trim()][0]!.toUpperCase();
      }
    });

    const strip = document.getElementById('crawl');
    if (strip) {
      strip.textContent = all.map((s) => s.title.trim()).join(SEPARATORS[look]);
      crawl(strip, ctx);
    }

    fitHeadlines(stories);
    if (rows.isConnected && listRows.length) mark(ctx, listRows, stories.length, slot);
  },
  play() {
    document.getElementById('leads')!.style.visibility = '';
  },
});

/**
 * Each lead headline at the largest step whose lines hold it: its clamp's ellipsis comes only at the smallest. Every
 * headline is read before any is stepped, so stories that fit cost one layout between them.
 */
function fitHeadlines(stories: HTMLElement[]): void {
  const over = (el: HTMLElement) => {
    const h = el.querySelector<HTMLElement>('.headline')!;
    return h.scrollHeight > h.clientHeight + Number.parseFloat(getComputedStyle(h).fontSize) / 2 || h.scrollWidth > h.clientWidth + 1;
  };
  for (const story of stories.filter(over))
    for (const step of HEADLINE_STEPS.slice(1)) {
      story.style.setProperty('--fit', String(step));
      if (!over(story)) break;
    }
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
