import { describe, expect, it } from 'vitest';
import { normaliseFeed, parseNews } from '../src/index';
import atom from './fixtures/atom.xml?raw';
import npr from './fixtures/npr-news.xml?raw';

const rss = (items: string, head = '') => `<?xml version="1.0"?>${head}<rss version="2.0"><channel><title>Test</title>${items}</channel></rss>`;

describe('NPR RSS 2.0', () => {
  const feed = parseNews(npr);

  it('takes the channel title and every titled item, newest first, dates in UTC', () => {
    expect(feed.title).toBe('NPR Topics: News');
    expect(feed.items).toHaveLength(10);
    expect(feed.items[0]).toEqual({
      title: 'Trump is in Asia ahead of Xi, Putin summit. And, tech leaders want Huang back at Nvidia',
      published: '2026-11-17T12:20:57+00:00',
      source: 'NPR Topics: News',
    });
    const times = feed.items.map((i) => Date.parse(i.published));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    for (const i of feed.items) expect(i.published).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/);
  });
});

describe('Atom', () => {
  it('reads titles with entities and CDATA, prefers updated over published, and drops untitled entries', () => {
    expect(parseNews(atom)).toEqual({
      title: 'Parks & Recreation Department: Updates',
      language: 'en',
      items: [
        {
          title: 'Skating rink opens Saturday – free rentals all weekend',
          published: '2026-11-17T12:30:00+00:00',
          source: 'Parks & Recreation Department: Updates',
        },
        {
          title: 'Leaf collection: the last pickup for the north side is Nov 20',
          published: '2026-11-14T08:00:00+00:00',
          source: 'Parks & Recreation Department: Updates',
        },
        { title: 'Winter hours start December 1', published: '2026-11-10T14:00:00+00:00', source: 'Parks & Recreation Department: Updates' },
      ],
    });
  });
});

describe('language', () => {
  it("carries the feed's declared language, RSS <language> or Atom xml:lang", () => {
    expect(parseNews(npr).language).toBe('en');
    expect(parseNews(atom).language).toBe('en');
    expect(parseNews(rss('<item><title>Bonjour</title></item>', '').replace('<channel>', '<channel><language> fr-FR </language>')).language).toBe('fr-FR');
  });

  it('gives an empty language when the feed has none, or one that is not a language tag', () => {
    expect(parseNews(rss('<item><title>Hi</title></item>')).language).toBe('');
    expect(parseNews(rss('<item><title>Hi</title></item>').replace('<channel>', '<channel><language>not a <b>tag</b></language>')).language).toBe('');
  });
});

describe('XML safety', () => {
  const laughs = `<?xml version="1.0"?>
<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>
<rss version="2.0"><channel><title>&lol2;</title></channel></rss>`;

  it('refuses a DOCTYPE, an entity declaration, and a DOCTYPE hidden after a comment', () => {
    for (const body of [
      laughs,
      rss('<item><title>x</title></item>', '<!DOCTYPE rss SYSTEM "https://example.com/rss.dtd">'),
      rss('<item><title>x</title></item>', '<!-- a <b>comment</b> --><!doctype rss>'),
      rss('<item><title><![CDATA[<!ENTITY x "y">]]></title></item>'),
    ]) {
      expect(() => parseNews(body)).toThrow(expect.objectContaining({ code: 'doctype' }));
    }
  });

  it('allows the word DOCTYPE in content after the root element', () => {
    expect(parseNews(rss('<item><title><![CDATA[Why <!DOCTYPE html> matters]]></title></item>')).items[0]?.title).toBe('Why <!DOCTYPE html> matters');
  });

  it('refuses malformed XML, other formats and oversized bodies', () => {
    expect(() => parseNews('<rss><channel><item></rss>')).toThrow(expect.objectContaining({ code: 'malformed' }));
    expect(() => parseNews('<html><body>hi</body></html>')).toThrow(expect.objectContaining({ code: 'unknown-format' }));
    expect(() => parseNews(rss(`<item><title>${'x'.repeat(1_000_000)}</title></item>`))).toThrow(expect.objectContaining({ code: 'too-large' }));
  });
});

describe('RSS details', () => {
  it('keeps an unreadable date as written and sorts it last', () => {
    const feed = parseNews(
      rss('<item><title>Odd</title><pubDate>sometime</pubDate></item><item><title>New</title><pubDate>Tue, 17 Nov 2026 07:00:00 EST</pubDate></item>'),
    );
    expect(feed.items).toEqual([
      { title: 'New', published: '2026-11-17T12:00:00+00:00', source: 'Test' },
      { title: 'Odd', published: 'sometime', source: 'Test' },
    ]);
  });

  it('returns at most 20 items', () => {
    const many = Array.from({ length: 30 }, (_, i) => `<item><title>Item ${i}</title></item>`).join('');
    expect(parseNews(rss(many)).items).toHaveLength(20);
    expect(normaliseFeed('rss', rss(many), { maxItems: 5 }).items).toHaveLength(5);
  });
});
