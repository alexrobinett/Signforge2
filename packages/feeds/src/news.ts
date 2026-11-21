import type { NewsFeed } from '@signforge/contract';
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
  items: (NewsFeed['items'][number] & { image?: FeedImage })[];
  logo?: string;
}

type Node = Record<string, unknown>;

/** A BCP 47 tag's shape (`en`, `fr-FR`, `zh-Hant-TW`); anything else in `<language>` counts as none. */
const LANGUAGE_TAG = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  // Untrimmed, so text either side of a CDATA section keeps its spaces; text() collapses them.
  trimValues: false,
  // With DOCTYPEs refused, only fixed entities remain: XML's five, character references, and
  // HTML's named ones, which RSS writers use without declaring.
  processEntities: true,
  htmlEntities: true,
  isArray: (name) => name === 'item' || name === 'entry' || name === 'link',
});

/**
 * Entity declarations are how XML bombs work, and no real feed needs them. A DOCTYPE can only
 * appear before the root element; `<!ENTITY` is refused anywhere.
 */
function refuseDeclarations(text: string): void {
  const bare = text.replace(/<!--[\s\S]*?-->/g, '');
  const root = bare.search(/<[A-Za-z_]/);
  const prolog = root === -1 ? bare : bare.slice(0, root);
  if (/<!DOCTYPE/i.test(prolog) || /<!ENTITY/i.test(text)) {
    throw new FeedError('doctype', 'feed declares a DOCTYPE or entities');
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

const nodes = (v: unknown): Node[] => each(v).filter(isNode);

const attr = (n: Node, name: string): string => {
  const v = n[`@${name}`];
  return typeof v === 'string' ? v.trim() : '';
};

/** A width or height attribute as a whole number of pixels, or nothing. */
const pixels = (v: string): number | undefined => (/^\d{1,6}$/.test(v) && Number(v) > 0 ? Number(v) : undefined);

/** `rel` against `base`; `base` itself when `rel` is empty or does not resolve. */
function resolve(rel: string, base: string | undefined): string | undefined {
  try {
    return new URL(rel, base).href;
  } catch {
    return base;
  }
}

/** `raw` as an absolute http or https URL, or nothing: `data:`, `file:`, `javascript:` and the rest are dropped. */
function imageUrl(raw: string, base: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw, base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function sized(url: string, width: number | undefined, height: number | undefined): FeedImage {
  return { url, ...(width ? { width } : {}), ...(height ? { height } : {}) };
}

/** The widest of `candidates` whose `key` attribute is an image URL; the first, when none gives a width. */
function widest(candidates: Node[], key: 'url' | 'href', base: string | undefined): FeedImage | undefined {
  let best: FeedImage | undefined;
  for (const n of candidates) {
    const url = imageUrl(attr(n, key), base);
    const width = pixels(attr(n, 'width'));
    if (url && (!best || (width ?? 0) > (best.width ?? 0))) best = sized(url, width, pixels(attr(n, 'height')));
  }
  return best;
}

const imageType = (n: Node) => attr(n, 'type').toLowerCase().startsWith('image/');

/** A Media RSS entry that is not video or audio. Many feeds give neither `medium` nor `type`. */
function mediaImage(n: Node): boolean {
  const medium = attr(n, 'medium').toLowerCase();
  const type = attr(n, 'type');
  return (!medium || medium === 'image') && (!type || imageType(n));
}

/** The character references HTML attributes use; a named one other than XML's five stays as written. */
function unescapeHtml(v: string): string {
  return v.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/gi, (ref, name: string) => {
    if (name[0] !== '#') return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name.toLowerCase()] ?? ref;
    const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code <= 0x10ffff ? String.fromCodePoint(code) : ref;
  });
}

/** One tag's attributes by lower-case name, the first of a repeated name winning. */
function attributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, name = '', dq, sq, bare] of tag.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const key = name.toLowerCase();
    if (!out.has(key)) out.set(key, unescapeHtml(dq ?? sq ?? bare ?? '').trim());
  }
  return out;
}

/**
 * An `srcset`'s largest candidate that is an image URL: the widest by `w`, else the densest by `x`.
 * Candidates end at a comma followed by a space or after a descriptor, since CDN URLs hold commas.
 */
function largestCandidate(srcset: string, base: string | undefined): FeedImage | undefined {
  let best: { url: string; w: number; x: number } | undefined;
  for (const candidate of srcset.split(/,\s+|(?<=\s[\d.]+[wx]),/)) {
    const [raw = '', descriptor = ''] = candidate.trim().replace(/,+$/, '').split(/\s+/);
    const url = imageUrl(raw, base);
    const w = Number(/^(\d+)w$/.exec(descriptor)?.[1] ?? 0);
    const x = Number(/^([\d.]+)x$/.exec(descriptor)?.[1] ?? 1) || 1;
    if (url && (!best || w > best.w || (w === best.w && x > best.x))) best = { url, w, x };
  }
  return best && sized(best.url, best.w || undefined, undefined);
}

/**
 * Pictures in a story's body that are not its photo: tracking pixels and spacers (by name, or
 * feedburner's), Gravatar avatars and WordPress emoji, by URL or by class.
 */
const NOT_A_PHOTO_URL = /(?:^|[/._-])(?:pixel|spacer)(?:[/._-]|$)|(?:^|\.)gravatar\.com\/|feedburner|^s\.w\.org\/images\/core\/emoji\//i;
const NOT_A_PHOTO_CLASS = /(?:^|\s)(?:emoji|wp-smiley|avatar)(?:\s|$)/i;

/**
 * The first real picture in a story's HTML body. Only `<img>` tags are read, by a scan that moves
 * forward only, so a hostile body costs one pass. NPR writes `src='undefined'` for a story without
 * a photo.
 */
function bodyImage(html: string, base: string | undefined): FeedImage | undefined {
  const img = /<img[\s/>]/gi;
  for (let m = img.exec(html); m; m = img.exec(html)) {
    const end = html.indexOf('>', m.index + 4);
    if (end === -1) return undefined;
    img.lastIndex = end + 1;
    const a = attributes(html.slice(m.index + 4, end));
    const width = a.get('width') ?? '';
    const height = a.get('height') ?? '';
    if (/^\d+$/.test(width) && Number(width) <= 2) continue;
    if (/^\d+$/.test(height) && Number(height) <= 2) continue;
    if (NOT_A_PHOTO_CLASS.test(a.get('class') ?? '')) continue;
    const src = a.get('src') ?? '';
    const url = src === 'undefined' ? undefined : imageUrl(src, base);
    const found = largestCandidate(a.get('srcset') ?? '', base) ?? (url ? sized(url, pixels(width), pixels(height)) : undefined);
    if (!found) continue;
    const u = new URL(found.url);
    if (!NOT_A_PHOTO_URL.test(u.host + u.pathname)) return found;
  }
  return undefined;
}

/**
 * An item's image, from the first of these that has one: Media RSS content (the widest image),
 * Media RSS thumbnails (the widest), an RSS enclosure or an Atom enclosure link of an image type,
 * `itunes:image`, and the first real picture in its HTML `bodies` (RSS `content:encoded` then
 * `description`, Atom `content` then `summary`). Namespace prefixes are dropped when parsing, so
 * `media:content` shares its name with Atom's `content` and is told by its `url`.
 */
function itemImage(it: Node, bodies: unknown[], base: string | undefined): FeedImage | undefined {
  const groups = nodes(it.group);
  const media = [it, ...groups].flatMap((n) => nodes(n.content)).filter((n) => attr(n, 'url'));
  return (
    widest(media.filter(mediaImage), 'url', base) ??
    widest(
      [it, ...groups, ...media].flatMap((n) => nodes(n.thumbnail)),
      'url',
      base,
    ) ??
    widest(nodes(it.enclosure).filter(imageType), 'url', base) ??
    widest(
      nodes(it.link).filter((n) => attr(n, 'rel') === 'enclosure' && imageType(n)),
      'href',
      base,
    ) ??
    widest(nodes(it.image), 'href', base) ??
    bodies
      .filter((b) => !(isNode(b) && attr(b, 'url')))
      .map((b) => bodyImage(text(b), isNode(b) ? resolve(attr(b, 'base'), base) : base))
      .find(Boolean)
  );
}

/**
 * What an item's relative links resolve against: the `xml:base` in scope (the item's, then the
 * feed's), else the item's own link, else the feed's URL.
 */
function itemBase(item: Node, feed: Node, link: string, feedBase: string | undefined): string | undefined {
  if (attr(item, 'base')) return resolve(attr(item, 'base'), feedBase);
  return attr(feed, 'base') ? feedBase : resolve(link, feedBase);
}

/** A feed date as an ISO 8601 instant in UTC, or the original text if it does not parse. */
function published(raw: string): string {
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? raw : isoInstant(ms, 0);
}

/**
 * An RSS 2.0 or Atom feed as a NewsFeed: the channel title and the items that have titles,
 * newest first.
 */
export function parseNews(body: string, options: NewsOptions = {}): ParsedNews {
  const o = { ...LIMITS, ...options };
  checkSize(body, o.maxBytes);
  refuseDeclarations(body);

  let doc: Node;
  try {
    doc = parser.parse(body, true) as Node;
  } catch (e) {
    // biome-ignore lint/style/useErrorCause: the cause is passed, in the options argument; the rule reads only the second argument.
    throw new FeedError('malformed', `not an XML feed: ${(e as Error).message.slice(0, 80)}`, { cause: e });
  }

  let title = '';
  let language = '';
  let logo: string | undefined;
  // An item's image is looked for only once the item is among those kept.
  let stories: { item: NewsFeed['items'][number]; image: () => FeedImage | undefined }[] = [];
  const rss = doc.rss as Node | undefined;
  const atom = doc.feed as Node | undefined;
  if (rss && typeof rss === 'object' && rss.channel && typeof rss.channel === 'object') {
    const channel = rss.channel as Node;
    const feedBase = resolve(attr(channel, 'base'), o.url);
    title = text(channel.title);
    language = text(channel.language);
    logo = nodes(channel.image)
      .map((n) => imageUrl(text(n.url), feedBase))
      .find(Boolean);
    stories = ((channel.item as Node[] | undefined) ?? []).map((it) => {
      const base = itemBase(it, channel, each(it.link).map(text).find(Boolean) ?? '', feedBase);
      return {
        item: { title: text(it.title), published: published(text(it.pubDate) || text(it.date)), source: title },
        image: () => itemImage(it, [...each(it.encoded), ...each(it.description)], base),
      };
    });
  } else if (atom && typeof atom === 'object') {
    const feedBase = resolve(attr(atom, 'base'), o.url);
    title = text(atom.title);
    language = text(atom['@lang']);
    logo = imageUrl(text(atom.logo), feedBase) ?? imageUrl(text(atom.icon), feedBase);
    stories = ((atom.entry as Node[] | undefined) ?? []).map((entry) => {
      const link = nodes(entry.link).find((n) => ['', 'alternate'].includes(attr(n, 'rel')));
      const base = itemBase(entry, atom, link ? attr(link, 'href') : '', feedBase);
      return {
        item: { title: text(entry.title), published: published(text(entry.updated) || text(entry.published)), source: title },
        image: () => itemImage(entry, [...each(entry.content), ...each(entry.summary)], base),
      };
    });
  } else {
    throw new FeedError('unknown-format', 'not an RSS 2.0 or Atom feed');
  }

  // Newest first, as the contract promises; items without a readable date keep their order last.
  const when = (i: NewsFeed['items'][number]) => {
    const ms = Date.parse(i.published);
    return Number.isNaN(ms) ? -Infinity : ms;
  };
  const items = stories
    .filter((s) => s.item.title)
    .map((story, index) => ({ story, index, ms: when(story.item) }))
    .sort((a, b) => b.ms - a.ms || a.index - b.index)
    .slice(0, o.maxItems)
    .map(({ story }) => {
      const image = story.image();
      return image ? { ...story.item, image } : story.item;
    });
  return { title, language: LANGUAGE_TAG.test(language) ? language : '', items, ...(logo ? { logo } : {}) };
}
