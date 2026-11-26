import { NEWS_SUMMARY_MAX, type NewsFeed, SCREEN_BOX } from '@signforge/contract';
import { XMLParser } from 'fast-xml-parser';
import { checkSize, FeedError, LIMITS } from './errors';
import { isoInstant } from './time';

export interface NewsOptions {
  maxBytes?: number;
  maxItems?: number;
  /** The feed's own URL, which relative image links resolve against last. */
  url?: string;
}

/**
 * A story's picture or a feed's logo as the feed names it: an http or https URL, with the size the
 * feed gives. It stays on the server: the URL is a third party's and screens have no network, so
 * `normaliseFeed` leaves images out of the `NewsFeed` that snapshots carry.
 */
export interface FeedImage {
  url: string;
  width?: number;
  height?: number;
}

/** A `NewsFeed` with each item's image and the feed's logo, for the server to fetch and store. */
export interface ParsedNews extends Omit<NewsFeed, 'items'> {
  items: (Omit<NewsFeed['items'][number], 'image'> & { image?: FeedImage })[];
  logo?: string;
}

type Node = Record<string, unknown>;

/** A BCP 47 tag's shape (`en`, `fr-FR`, `zh-Hant-TW`); anything else in `<language>` counts as none. */
const LANGUAGE_TAG = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  // Prefixes are kept, so an element is known by its namespace (`El.kids`), not by what a feed calls it.
  removeNSPrefix: false,
  parseTagValue: false,
  parseAttributeValue: false,
  // Untrimmed, so text either side of a CDATA section keeps its spaces; text() collapses them.
  trimValues: false,
  // With DOCTYPEs refused, only fixed entities remain: XML's five, character references, and
  // HTML's named ones, which RSS writers use without declaring.
  processEntities: true,
  htmlEntities: true,
});

/**
 * A namespace name as compared: without case, a final slash or the difference between http and
 * https, all of which feeds vary for Media RSS and Dublin Core.
 */
const nsName = (uri: string) =>
  uri
    .trim()
    .replace(/\/$/, '')
    .toLowerCase()
    .replace(/^https:/, 'http:');

const NS = {
  none: '',
  /** RSS 2.0 as UserLand published it, which some feeds still declare as their default namespace. */
  userland: nsName('http://backend.userland.com/rss2'),
  atom: nsName('http://www.w3.org/2005/Atom'),
  /** Atom 0.3, read as Atom: its titles, links and bodies match; its `modified` and `issued` dates are not read. */
  atom03: nsName('http://purl.org/atom/ns#'),
  media: nsName('http://search.yahoo.com/mrss/'),
  content: nsName('http://purl.org/rss/1.0/modules/content/'),
  itunes: nsName('http://www.itunes.com/dtds/podcast-1.0.dtd'),
  dc: nsName('http://purl.org/dc/elements/1.1/'),
  xhtml: nsName('http://www.w3.org/1999/xhtml'),
};

/** The longest image URL or `xml:base` used, in characters, before or after resolving. */
const MAX_URL = 2048;

/**
 * URLs resolved and XHTML elements visited in one parse's image search. A real feed uses a few
 * hundred; the bound keeps a hostile one from making a poll parse a million URLs.
 */
const SEARCH_BUDGET = 2000;

interface Search {
  left: number;
}

/**
 * Where a tag that fast-xml-parser reads from `from` ends: the index of `close`, quoted values
 * skipped as the parser skips them (`tagExpWithClosingIndex`), or -1 when it never ends.
 */
function tagEnd(text: string, from: number, close: '>' | '?>'): number {
  for (let j = from; j < text.length; j++) {
    const c = text[j];
    if (c === '"' || c === "'") {
      j = text.indexOf(c, j + 1);
      if (j === -1) return -1;
    } else if (c === close[0] && (close === '>' || text[j + 1] === '>')) return j;
  }
  return -1;
}

/**
 * Entity declarations are how XML bombs work, and no real feed needs them: `<!ENTITY` is refused
 * anywhere, and a DOCTYPE wherever fast-xml-parser 5 would read one. To agree with the parser by
 * construction, the document is walked as its own loop walks it (`OrderedObjParser.parseXml`), each
 * kind of markup ending where the parser ends it: a closing tag at the next `>`; a processing
 * instruction at `?>` from just after its `<`, and an opening tag at `>` from there, both skipping
 * quoted values; a comment at `-->` after its `<!--`; CDATA at `]]>`. What the parser would refuse
 * as never closed is refused here as `malformed`. A test checks the walk against the parser on
 * generated prologs. `<!d` is refused too, though the parser reads only `<!D` as a DOCTYPE.
 */
function refuseDeclarations(text: string): void {
  if (/<!ENTITY/i.test(text)) throw new FeedError('doctype', 'feed declares a DOCTYPE or entities');
  for (let i = text.indexOf('<'); i !== -1; i = text.indexOf('<', i + 1)) {
    let end: number;
    if (text[i + 1] === '/') end = text.indexOf('>', i);
    else if (text[i + 1] === '?') {
      const q = tagEnd(text, i + 1, '?>');
      end = q === -1 ? -1 : q + 1;
    } else if (text.startsWith('!--', i + 1)) {
      const e = text.indexOf('-->', i + 4);
      end = e === -1 ? -1 : e + 2;
    } else if (text[i + 1] === '!' && (text[i + 2] === 'D' || text[i + 2] === 'd')) {
      throw new FeedError('doctype', 'feed declares a DOCTYPE or entities');
    } else if (text.startsWith('![', i + 1)) {
      const e = text.indexOf(']]>', i);
      end = e === -1 ? -1 : e + 2;
    } else end = tagEnd(text, i + 1, '>');
    if (end === -1) throw new FeedError('malformed', 'a tag, comment, CDATA section or processing instruction is never closed');
    i = end;
  }
}

/** The text of an element, whether it parsed as a string or as an object with attributes. */
function text(v: unknown): string {
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === 'string' || typeof v === 'number') return String(v).replace(/\s+/g, ' ').trim();
  if (v && typeof v === 'object' && '#text' in v) return text((v as Node)['#text']);
  return '';
}

const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An element that may appear once or many times, as a list. */
const each = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

/**
 * A parsed element with what it inherits: the namespace prefixes declared on it and above it, and
 * its base URL, its `xml:base` against its parent's, worked out when first asked for. An item can
 * carry its link, which is its base when no `xml:base` is in scope.
 */
class El {
  readonly #declared: Map<string, string> | undefined;
  #base: { url: string | undefined } | undefined;

  constructor(
    readonly v: unknown,
    readonly parent: El | undefined,
    private readonly from: { root?: string; link?: string } = {},
  ) {
    if (!isNode(v)) return;
    for (const key of Object.keys(v)) {
      const uri = v[key];
      if ((key === '@xmlns' || key.startsWith('@xmlns:')) && typeof uri === 'string') (this.#declared ??= new Map()).set(key.slice(7), nsName(uri));
    }
  }

  attr(name: string): string {
    const v = isNode(this.v) ? this.v[`@${name}`] : undefined;
    return typeof v === 'string' ? v.trim() : '';
  }

  /** The namespace a prefix (`''` for none) names here. */
  namespace(prefix: string): string | undefined {
    for (let e: El | undefined = this; e; e = e.parent) {
      const uri = e.#declared?.get(prefix);
      if (uri !== undefined) return uri;
    }
    // Feeds write `dc:date` without declaring the prefix; no other prefix is read undeclared.
    if (prefix === 'dc') return NS.dc;
    return prefix === '' ? NS.none : undefined;
  }

  /** The child elements with this namespace and local name, in order. */
  kids(ns: string, local: string): El[] {
    const out: El[] = [];
    if (!isNode(this.v)) return out;
    for (const [key, value] of Object.entries(this.v)) {
      if (key[0] === '@' || key[0] === '#' || key[0] === '?') continue;
      const colon = key.indexOf(':');
      if (key.slice(colon + 1) !== local) continue;
      for (const v of each(value)) {
        const child = new El(v, this);
        if (child.namespace(colon === -1 ? '' : key.slice(0, colon)) === ns) out.push(child);
      }
    }
    return out;
  }

  /** The text of the first child with this name. */
  text(ns: string, local: string): string {
    return text(this.kids(ns, local)[0]?.v);
  }

  /** The same element as an item whose link is its base when no `xml:base` is in scope. */
  withLink(link: string): El {
    return new El(this.v, this.parent, { link });
  }

  base(search: Search): string | undefined {
    if (!this.#base) {
      const parent = this.parent ? this.parent.base(search) : this.from.root;
      const own = this.attr('xml:base');
      const inScope = (e: El | undefined): boolean => !!e && (!!e.attr('xml:base') || inScope(e.parent));
      const rel = own || (this.from.link !== undefined && !inScope(this.parent) ? this.from.link : '');
      this.#base = { url: rel ? resolveUrl(rel, parent, search)?.href : parent };
    }
    return this.#base.url;
  }
}

/** `raw` against `base`, within the search's budget and `MAX_URL`. */
function resolveUrl(raw: string, base: string | undefined, search: Search): URL | undefined {
  if (!raw || raw.length > MAX_URL || search.left <= 0) return undefined;
  search.left--;
  try {
    const u = new URL(raw, base);
    return u.href.length <= MAX_URL ? u : undefined;
  } catch {
    return undefined;
  }
}

/** `raw` as an absolute http or https URL, or nothing: `data:`, `file:`, `javascript:` and the rest are dropped. */
function imageUrl(raw: string, base: string | undefined, search: Search): URL | undefined {
  const u = resolveUrl(raw, base, search);
  return u && (u.protocol === 'https:' || u.protocol === 'http:') ? u : undefined;
}

/** A width or height attribute as a whole number of pixels, or nothing. */
const pixels = (v: string): number | undefined => (/^\d{1,6}$/.test(v) && Number(v) > 0 ? Number(v) : undefined);

function sized(url: string, width: number | undefined, height: number | undefined): FeedImage {
  return { url, ...(width ? { width } : {}), ...(height ? { height } : {}) };
}

/** The screen box a feed photo aims to cover: choosing a candidate close to this avoids downloading and scaling 4K copies. */
const TARGET_BOX = SCREEN_BOX.landscape;

const coversTarget = (width: number | undefined, height: number | undefined): boolean =>
  width !== undefined && width >= TARGET_BOX.w && (height === undefined || height >= TARGET_BOX.h);

/** Whether `next` is a better fit for `TARGET_BOX` than `best`: the smallest candidate that covers it, else the widest. */
function betterSize(next: { width?: number; height?: number }, best: { width?: number; height?: number }): boolean {
  const nc = coversTarget(next.width, next.height);
  const bc = coversTarget(best.width, best.height);
  if (nc !== bc) return nc;
  const nw = next.width ?? 0;
  const bw = best.width ?? 0;
  if (nc) return nw < bw || (nw === bw && (next.height ?? Infinity) < (best.height ?? Infinity));
  return nw > bw || (nw === bw && (next.height ?? 0) > (best.height ?? 0));
}

/** The best-fitting of `candidates` whose `key` attribute is an image URL: smallest covering `TARGET_BOX`, else widest, else first. */
function bestFit(candidates: El[], key: 'url' | 'href', search: Search): FeedImage | undefined {
  let best: FeedImage | undefined;
  for (const e of candidates) {
    const url = imageUrl(e.attr(key), e.base(search), search);
    if (!url) continue;
    const next = sized(url.href, pixels(e.attr('width')), pixels(e.attr('height')));
    if (!best || betterSize(next, best)) best = next;
  }
  return best;
}

const imageType = (e: El) => e.attr('type').toLowerCase().startsWith('image/');

/** A Media RSS entry that is not video or audio. Many feeds give neither `medium` nor `type`. */
function mediaImage(e: El): boolean {
  const medium = e.attr('medium').toLowerCase();
  return (!medium || medium === 'image') && (!e.attr('type') || imageType(e));
}

/** The character references HTML attributes use; a named one other than XML's five stays as written. */
function unescapeHtml(v: string): string {
  return v.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/gi, (ref, name: string) => {
    if (name[0] !== '#') return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name.toLowerCase()] ?? ref;
    const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    if (code > 0x10ffff) return ref;
    // A lone surrogate is no character: as HTML reads one, the replacement character (review of #627).
    return code >= 0xd800 && code <= 0xdfff ? '\ufffd' : String.fromCodePoint(code);
  });
}

/** HTML's Latin-1 named references, U+00A0 to U+00FF in order: the accents and symbols descriptions use (#477). */
const LATIN1 =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'.split(
    ' ',
  );

/**
 * HTML's named references a story description may hold, beyond XML's five: Latin-1, then typography, letters and
 * symbols news uses. Names are case-sensitive, as in HTML (`&Eacute;` is not `&eacute;`); one not here stays as written.
 */
const NAMED_TEXT: Record<string, string> = {
  ...Object.fromEntries(LATIN1.map((name, i) => [name, String.fromCodePoint(0xa0 + i)])),
  // A space a screen may wrap at, and a hyphen it would only show at a break: neither is kept.
  nbsp: ' ',
  shy: '',
  OElig: 'Œ',
  oelig: 'œ',
  Scaron: 'Š',
  scaron: 'š',
  Yuml: 'Ÿ',
  fnof: 'ƒ',
  circ: 'ˆ',
  tilde: '˜',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  dagger: '†',
  Dagger: '‡',
  bull: '•',
  hellip: '…',
  permil: '‰',
  prime: '′',
  Prime: '″',
  lsaquo: '‹',
  rsaquo: '›',
  oline: '‾',
  frasl: '⁄',
  euro: '€',
  trade: '™',
  larr: '←',
  uarr: '↑',
  rarr: '→',
  darr: '↓',
  harr: '↔',
  minus: '−',
  le: '≤',
  ge: '≥',
  ne: '≠',
  asymp: '≈',
  infin: '∞',
};

/**
 * Characters a summary never carries (#477): the C0 and C1 controls but tab, line feed and carriage return (which
 * collapse to a space), and the bidirectional controls that would turn a screen's text around (U+202A to U+202E,
 * U+2066 to U+2069), whether written or read from a numeric reference. Written as escapes: GitHub flags raw ones.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: finding control characters is what it is for.
const UNSHOWN = /[\0-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;

/** Whether `html` at `at` is `word`, any case, read without lower-casing the whole text: `İ` lower-cases to two characters. */
const isAt = (html: string, at: number, word: string) => html.slice(at, at + word.length).toLowerCase() === word;

/**
 * Where a comment that opened before `from` ends, its last `>`; -1 when unclosed. As HTML reads one, `<!-->` and
 * `<!--->` are empty comments, and `--!>` ends one as `-->` does (review of #627).
 */
function commentEnd(html: string, from: number): number {
  if (html[from] === '>') return from;
  if (html.startsWith('->', from)) return from + 1;
  const close = /--!?>/g;
  close.lastIndex = from;
  const m = close.exec(html);
  return m ? m.index + m[0].length - 1 : -1;
}

/** The end of a script or style's body, `</name` in any case, from `from`; -1 when unclosed. */
function closeOf(html: string, name: string, from: number): number {
  const re = new RegExp(`</${name}`, 'gi');
  re.lastIndex = from;
  return re.exec(html)?.index ?? -1;
}

/**
 * A story's description as plain text (the contract's `summary`): tags dropped with the bodies of
 * scripts and styles, character references read, spaces collapsed, and at most `NEWS_SUMMARY_MAX`
 * characters, cut on a word with "…". Undefined when nothing is left or it only repeats the title.
 * A `<` opens a tag only before a letter, `/`, `!` or `?`, as in HTML, so "< 5%" is prose; a comment
 * ends at `-->`, though it holds a `>`. Each scan starts where the last ended, so a body of unclosed
 * tags costs linear time.
 */
function summaryOf(html: string, title: string): { summary: string } | Record<string, never> {
  let out = '';
  for (let i = 0, from = 0; ; ) {
    const lt = html.indexOf('<', from);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    if (!/[a-z/!?]/i.test(html[lt + 1] ?? '')) {
      // Prose: kept, and the scan goes on past it.
      from = lt + 1;
      continue;
    }
    out += `${html.slice(i, lt)} `;
    let end: number;
    if (isAt(html, lt, '<!--')) end = commentEnd(html, lt + 4);
    else {
      // Its quoted values skipped, as the feed's own tags are: `<img alt="1 > 0">` is one tag (review of #627).
      const gt = tagEnd(html, lt + 1, '>');
      const hidden =
        gt === -1 ? undefined : ['script', 'style'].find((name) => isAt(html, lt + 1, name) && !/[a-z0-9]/i.test(html[lt + 1 + name.length] ?? ''));
      const close = hidden ? closeOf(html, hidden, gt) : gt;
      end = close === -1 ? -1 : html.indexOf('>', close);
    }
    if (end === -1) break;
    i = from = end + 1;
  }
  // Own keys only: `&constructor;` is no reference, though every object has one (review of #627).
  const text = unescapeHtml(out.replace(/&([a-z][a-z0-9]*);/gi, (ref, name: string) => (Object.hasOwn(NAMED_TEXT, name) ? NAMED_TEXT[name]! : ref)))
    .replace(UNSHOWN, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text.toLowerCase() === title.toLowerCase()) return {};
  if (text.length <= NEWS_SUMMARY_MAX) return { summary: text };
  const space = text.lastIndexOf(' ', NEWS_SUMMARY_MAX - 1);
  // With no space to cut on, never between the two halves of a surrogate pair.
  const at = space > 0 ? space : NEWS_SUMMARY_MAX - 1 - (/[\ud800-\udbff]/.test(text[NEWS_SUMMARY_MAX - 2] ?? '') ? 1 : 0);
  return { summary: `${text.slice(0, at).replace(/[\s,;:.–—-]+$/, '')}…` };
}

/** Gravatar avatars, WordPress emoji and feedburner's pixels, by host and path. */
const NOT_A_PHOTO_URL = /(?:^|\.)gravatar\.com\/|feedburner|^s\.w\.org\/images\/core\/emoji\//i;

/** Names a tracking pixel or spacer goes by, as a host label or a folder. */
const TRACKER = new Set(['pixel', 'spacer', 'tracking']);

/** Image hosts that publishers serve article photos from, though a label names them `pixel`. */
const PHOTO_HOSTS = new Set(['pixel.nymag.com']);

/** Words a tracking pixel's or spacer's file name is made of, and nothing else: `tracking-pixel.gif`, `spacer_1x1.gif`. */
const TRACKER_FILE = new Set([...TRACKER, '1x1', 'blank', 'transparent']);

/**
 * Whether a body picture is a tracking pixel or spacer by its URL: a host label or folder named
 * `pixel`, `spacer` or `tracking` (but not one of `PHOTO_HOSTS`), or a file named only with tracker
 * words. Names match whole, so `google-pixel-10-review.jpg` and `/pixels/` are photos.
 */
function trackerUrl(u: URL): boolean {
  const folders = u.pathname.toLowerCase().split('/');
  const file = folders.pop() ?? '';
  const stem = file.includes('.') ? file.slice(0, file.lastIndexOf('.')) : file;
  return (
    (!PHOTO_HOSTS.has(u.hostname) && u.hostname.split('.').some((label) => TRACKER.has(label))) ||
    folders.some((folder) => TRACKER.has(folder)) ||
    (stem !== '' && stem.split(/[-_.]/).every((word) => TRACKER_FILE.has(word)))
  );
}

const NOT_A_PHOTO_CLASS = /(?:^|\s)(?:emoji|wp-smiley|avatar)(?:\s|$)/i;

/** `raw` as the URL of a body picture that may be the story's photo. */
function photoUrl(raw: string, base: string | undefined, search: Search): string | undefined {
  const u = imageUrl(raw, base, search);
  return u && !NOT_A_PHOTO_URL.test(u.host + u.pathname) && !trackerUrl(u) ? u.href : undefined;
}

const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/**
 * An `srcset`'s best-fitting candidate that may be the photo: the smallest by `w` that covers
 * `TARGET_BOX`, else the widest by `w`, else the densest by `x`. Read forward once, as HTML does:
 * a candidate's URL runs to whitespace (so a CDN URL keeps its commas), and a comma ends its
 * descriptors.
 */
function bestSrcsetCandidate(srcset: string, base: string | undefined, search: Search): FeedImage | undefined {
  let best: { url: string; w: number; x: number } | undefined;
  let i = 0;
  while (i < srcset.length) {
    while (i < srcset.length && (isSpace(srcset[i]) || srcset[i] === ',')) i++;
    const start = i;
    while (i < srcset.length && !isSpace(srcset[i])) i++;
    let end = i;
    let descriptor = '';
    if (srcset[end - 1] === ',') {
      while (end > start && srcset[end - 1] === ',') end--;
    } else {
      const comma = srcset.indexOf(',', i);
      const stop = comma === -1 ? srcset.length : comma;
      descriptor = srcset.slice(i, stop).trim();
      i = stop + 1;
    }
    if (end === start) continue;
    const url = photoUrl(srcset.slice(start, end), base, search);
    const w = Number(/^(\d+)w$/.exec(descriptor)?.[1] ?? 0);
    const x = Number(/^([\d.]+)x$/.exec(descriptor)?.[1] ?? 1) || 1;
    if (url && (!best || (w || best.w ? betterSize({ width: w || undefined }, { width: best.w || undefined }) : x > best.x))) best = { url, w, x };
  }
  return best && sized(best.url, best.w || undefined, undefined);
}

/** A body `<img>` as the story's photo, from its attributes, or nothing. NPR writes `src='undefined'` for none. */
function imgImage(get: (name: string) => string, base: string | undefined, search: Search): FeedImage | undefined {
  const width = get('width');
  const height = get('height');
  const tiny = (v: string) => /^\d+$/.test(v) && Number(v) <= 2;
  if (tiny(width) || tiny(height) || NOT_A_PHOTO_CLASS.test(get('class'))) return undefined;
  const fromSrcset = bestSrcsetCandidate(get('srcset'), base, search);
  if (fromSrcset) return fromSrcset;
  const src = get('src');
  const url = src === 'undefined' ? undefined : photoUrl(src, base, search);
  return url ? sized(url, pixels(width), pixels(height)) : undefined;
}

const isNameChar = (c: string | undefined) => !!c && /[A-Za-z0-9-]/.test(c);

/**
 * The first real picture in an HTML body. A tokenizer that only moves forward, as a browser reads
 * tags: quoted attribute values may hold `>`, comments and the insides of `script` and `style` are
 * skipped, and a tag or comment left open ends the body. So a hostile body costs one pass.
 */
function bodyImage(html: string, base: string | undefined, search: Search): FeedImage | undefined {
  let i = 0;
  while (search.left > 0) {
    const lt = html.indexOf('<', i);
    if (lt === -1) return undefined;
    if (html.startsWith('!--', lt + 1)) {
      const end = html.indexOf('-->', lt + 4);
      if (end === -1) return undefined;
      i = end + 3;
      continue;
    }
    let j = lt + 1;
    const closing = html[j] === '/';
    if (closing) j++;
    const nameStart = j;
    while (isNameChar(html[j])) j++;
    if (j === nameStart) {
      i = lt + 1;
      continue;
    }
    const name = html.slice(nameStart, j).toLowerCase();
    const attrs = new Map<string, string>();
    for (;;) {
      while (isSpace(html[j]) || html[j] === '/') j++;
      if (j >= html.length) return undefined;
      if (html[j] === '>') break;
      const attrStart = j++;
      while (j < html.length && !isSpace(html[j]) && html[j] !== '/' && html[j] !== '>' && html[j] !== '=') j++;
      const attr = html.slice(attrStart, j).toLowerCase();
      while (isSpace(html[j])) j++;
      let value = '';
      if (html[j] === '=') {
        j++;
        while (isSpace(html[j])) j++;
        const quote = html[j];
        if (quote === '"' || quote === "'") {
          const close = html.indexOf(quote, j + 1);
          if (close === -1) return undefined;
          value = html.slice(j + 1, close);
          j = close + 1;
        } else {
          const valueStart = j;
          while (j < html.length && !isSpace(html[j]) && html[j] !== '>') j++;
          value = html.slice(valueStart, j);
        }
      }
      if (name === 'img' && !attrs.has(attr)) attrs.set(attr, unescapeHtml(value).trim());
    }
    i = j + 1;
    if (closing) continue;
    if (name === 'img') {
      const found = imgImage((n) => attrs.get(n) ?? '', base, search);
      if (found) return found;
    } else if (name === 'script' || name === 'style') {
      const end = new RegExp(`</${name}`, 'gi');
      end.lastIndex = i;
      const m = end.exec(html);
      if (!m) return undefined;
      i = m.index;
    }
  }
  return undefined;
}

/**
 * The first real picture in Atom `xhtml` content, from its parsed elements: XHTML `img`s, depth
 * first. The parser groups an element's children by name, so siblings of different names are read
 * name by name.
 */
function xhtmlImage(content: El, search: Search): FeedImage | undefined {
  const stack: { e: El; img: boolean }[] = [{ e: content, img: false }];
  for (let next = stack.pop(); next && search.left > 0; next = stack.pop()) {
    search.left--;
    const { e, img } = next;
    if (img) {
      const found = imgImage((n) => e.attr(n), e.base(search), search);
      if (found) return found;
      continue;
    }
    if (!isNode(e.v)) continue;
    const children: { e: El; img: boolean }[] = [];
    for (const [key, value] of Object.entries(e.v)) {
      if (key[0] === '@' || key[0] === '#') continue;
      const colon = key.indexOf(':');
      for (const v of each(value)) {
        const child = new El(v, e);
        children.push({ e: child, img: key.slice(colon + 1) === 'img' && child.namespace(colon === -1 ? '' : key.slice(0, colon)) === NS.xhtml });
      }
    }
    for (const child of children.reverse()) stack.push(child);
  }
  return undefined;
}

/**
 * An item's image, from the first of these that has one: Media RSS content (best fit for
 * `TARGET_BOX`), Media RSS thumbnails (best fit), an RSS enclosure or an Atom enclosure link of an
 * image type, `itunes:image`, and the first real picture in its `bodies` (RSS `content:encoded`
 * then `description`, Atom `content` then `summary`).
 */
function itemImage(it: El, ns: { rss: string; atom: string }, bodies: El[], search: Search): FeedImage | undefined {
  const groups = it.kids(NS.media, 'group');
  const media = [it, ...groups].flatMap((e) => e.kids(NS.media, 'content'));
  const image =
    bestFit(media.filter(mediaImage), 'url', search) ??
    bestFit(
      [it, ...groups, ...media].flatMap((e) => e.kids(NS.media, 'thumbnail')),
      'url',
      search,
    ) ??
    bestFit(it.kids(ns.rss, 'enclosure').filter(imageType), 'url', search) ??
    bestFit(
      it.kids(ns.atom, 'link').filter((e) => e.attr('rel') === 'enclosure' && imageType(e)),
      'href',
      search,
    ) ??
    bestFit(it.kids(NS.itunes, 'image'), 'href', search);
  if (image) return image;
  for (const b of bodies) {
    const found = b.attr('type').toLowerCase() === 'xhtml' ? xhtmlImage(b, search) : bodyImage(text(b.v), b.base(search), search);
    if (found) return found;
  }
  return undefined;
}

/** A feed date as an ISO 8601 instant in UTC, or the original text if it does not parse. */
function published(raw: string): string {
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? raw : isoInstant(ms, 0);
}

/** The first of `namespaces` under which the document's root is `local`, with that root. */
function root(doc: El, local: string, namespaces: string[]): { ns: string; el: El } | undefined {
  for (const ns of namespaces) {
    const el = doc.kids(ns, local)[0];
    if (el) return { ns, el };
  }
  return undefined;
}

interface Story {
  item: Omit<NewsFeed['items'][number], 'image'>;
  image: (search: Search) => FeedImage | undefined;
}

/** A feed's text, its kept stories newest first, and how to find their images and its logo. */
function readNews(body: string, options: NewsOptions): { title: string; language: string; stories: Story[]; logo: (search: Search) => string | undefined } {
  const o = { ...LIMITS, ...options };
  checkSize(body, o.maxBytes);
  refuseDeclarations(body);

  let parsed: unknown;
  try {
    parsed = parser.parse(body, true);
  } catch (e) {
    // biome-ignore lint/style/useErrorCause: the cause is passed, in the options argument; the rule reads only the second argument.
    throw new FeedError('malformed', `not an XML feed: ${(e as Error).message.slice(0, 80)}`, { cause: e });
  }
  const doc = new El(parsed, undefined, o.url === undefined ? {} : { root: o.url });

  let title = '';
  let language = '';
  let stories: Story[] = [];
  let logo: (search: Search) => string | undefined;
  const rss = root(doc, 'rss', [NS.none, NS.userland]);
  const channel = rss?.el.kids(rss.ns, 'channel')[0];
  const atom = root(doc, 'feed', [NS.atom, NS.atom03]);
  if (rss && channel) {
    const r = rss.ns;
    title = channel.text(r, 'title');
    language = channel.text(r, 'language');
    logo = (search) => {
      const url = channel.kids(r, 'image')[0]?.kids(r, 'url')[0];
      return url && imageUrl(text(url.v), url.base(search), search)?.href;
    };
    stories = channel.kids(r, 'item').map((it) => ({
      item: {
        title: it.text(r, 'title'),
        published: published(it.text(r, 'pubDate') || it.text(NS.dc, 'date')),
        source: title,
        ...summaryOf(it.text(r, 'description'), it.text(r, 'title')),
      },
      image: (search) => {
        const item = it.withLink(
          it
            .kids(r, 'link')
            .map((l) => text(l.v))
            .find(Boolean) ?? '',
        );
        return itemImage(item, { rss: r, atom: NS.atom }, [...item.kids(NS.content, 'encoded'), ...item.kids(r, 'description')], search);
      },
    }));
  } else if (atom) {
    const { ns: a, el: feed } = atom;
    title = feed.text(a, 'title');
    language = feed.attr('xml:lang');
    logo = (search) => {
      for (const name of ['logo', 'icon']) {
        const el = feed.kids(a, name)[0];
        const url = el && imageUrl(text(el.v), el.base(search), search);
        if (url) return url.href;
      }
      return undefined;
    };
    stories = feed.kids(a, 'entry').map((entry) => ({
      item: {
        title: entry.text(a, 'title'),
        published: published(entry.text(a, 'updated') || entry.text(a, 'published')),
        source: title,
        ...summaryOf(entry.text(a, 'summary') || entry.text(a, 'content'), entry.text(a, 'title')),
      },
      image: (search) => {
        const link = entry.kids(a, 'link').find((l) => ['', 'alternate'].includes(l.attr('rel')));
        const item = entry.withLink(link?.attr('href') ?? '');
        return itemImage(item, { rss: NS.none, atom: a }, [...item.kids(a, 'content'), ...item.kids(a, 'summary')], search);
      },
    }));
  } else {
    throw new FeedError('unknown-format', 'not an RSS 2.0 or Atom feed');
  }

  // Newest first, as the contract promises; items without a readable date keep their order last.
  const when = (s: Story) => {
    const ms = Date.parse(s.item.published);
    return Number.isNaN(ms) ? -Infinity : ms;
  };
  stories = stories
    .filter((s) => s.item.title)
    .map((story, index) => ({ story, index, ms: when(story) }))
    .sort((a, b) => b.ms - a.ms || a.index - b.index)
    .slice(0, o.maxItems)
    .map(({ story }) => story);
  return { title, language: LANGUAGE_TAG.test(language) ? language : '', stories, logo };
}

/**
 * An RSS 2.0 or Atom feed as a NewsFeed (the channel title and the items that have titles, newest
 * first), with each kept item's image and the feed's logo, within `SEARCH_BUDGET`.
 */
export function parseNews(body: string, options: NewsOptions = {}): ParsedNews {
  const { title, language, stories, logo: logoOf } = readNews(body, options);
  // An equal share each, the logo's included, so one bloated story cannot cost the rest their images.
  const share = Math.floor(SEARCH_BUDGET / (stories.length + 1));
  const logo = logoOf({ left: share });
  const items = stories.map((s) => {
    const image = s.image({ left: share });
    return image ? { ...s.item, image } : s.item;
  });
  return { title, language, items, ...(logo ? { logo } : {}) };
}

/** The NewsFeed alone, as a snapshot carries it: no image is looked for. */
export function parseNewsFeed(body: string, options: NewsOptions = {}): NewsFeed {
  const { title, language, stories } = readNews(body, options);
  return { title, language, items: stories.map((s) => s.item) };
}
