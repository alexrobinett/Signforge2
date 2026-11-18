import type { NewsFeed } from '@signforge/contract';
import { XMLParser } from 'fast-xml-parser';
import { checkSize, FeedError, LIMITS } from './errors';
import { isoInstant } from './time';

export interface NewsOptions {
  maxBytes?: number;
  maxItems?: number;
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
 * appear before the root element; `<!ENTITY` is refused anywhere, as datad.py did.
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

/** A feed date as an ISO 8601 instant in UTC, or the original text if it does not parse. */
function published(raw: string): string {
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? raw : isoInstant(ms, 0);
}

/**
 * An RSS 2.0 or Atom feed as a NewsFeed: the channel title and the items that have titles,
 * newest first.
 */
export function parseNews(body: string, options: NewsOptions = {}): NewsFeed {
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
  let items: NewsFeed['items'] = [];
  const rss = doc.rss as Node | undefined;
  const atom = doc.feed as Node | undefined;
  if (rss && typeof rss === 'object' && rss.channel && typeof rss.channel === 'object') {
    const channel = rss.channel as Node;
    title = text(channel.title);
    language = text(channel.language);
    items = ((channel.item as Node[] | undefined) ?? []).map((it) => ({
      title: text(it.title),
      published: published(text(it.pubDate) || text(it.date)),
      source: title,
    }));
  } else if (atom && typeof atom === 'object') {
    title = text(atom.title);
    language = text(atom['@lang']);
    items = ((atom.entry as Node[] | undefined) ?? []).map((entry) => ({
      title: text(entry.title),
      published: published(text(entry.updated) || text(entry.published)),
      source: title,
    }));
  } else {
    throw new FeedError('unknown-format', 'not an RSS 2.0 or Atom feed');
  }

  items = items.filter((i) => i.title);
  // Newest first, as the contract promises; items without a readable date keep their order last.
  const when = (i: NewsFeed['items'][number]) => {
    const ms = Date.parse(i.published);
    return Number.isNaN(ms) ? -Infinity : ms;
  };
  items = items
    .map((item, index) => ({ item, index, ms: when(item) }))
    .sort((a, b) => b.ms - a.ms || a.index - b.index)
    .map((x) => x.item);
  return { title, language: LANGUAGE_TAG.test(language) ? language : '', items: items.slice(0, o.maxItems) };
}
