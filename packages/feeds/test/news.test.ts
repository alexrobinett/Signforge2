import { afterEach, describe, expect, it, vi } from 'vitest';
import { type FeedImage, LIMITS, normaliseFeed, parseNews } from '../src/index';
import atom from './fixtures/atom.xml?raw';
import atomEnclosures from './fixtures/atom-enclosures.xml?raw';
import atomXhtml from './fixtures/atom-xhtml.xml?raw';
import enclosures from './fixtures/enclosures.xml?raw';
import hostile from './fixtures/hostile.xml?raw';
import mediaRss from './fixtures/media-rss.xml?raw';
import npr from './fixtures/npr-news.xml?raw';
import wordpress from './fixtures/wordpress.xml?raw';
import { inLinearTime, linearMs } from './linear';

const images = (body: string, url?: string) => parseNews(body, url ? { url } : {}).items.map((i) => i.image);
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

describe('images', () => {
  it('takes the widest Media RSS image, in a media:group or on the item, skipping video and audio', () => {
    expect(images(mediaRss).slice(0, 2)).toEqual([
      { url: 'https://cdn.harbour.example/img/ferry-1600.jpg?w=1600&q=80', width: 1600, height: 900 },
      { url: 'https://cdn.harbour.example/img/lighthouse.jpg', width: 1200 },
    ]);
  });

  it('falls back to the widest media:thumbnail when the media:content is a video', () => {
    expect(images(mediaRss)[2]).toEqual({ url: 'https://cdn.harbour.example/img/storm-480.jpg', width: 480, height: 270 });
  });

  it('takes an RSS enclosure of an image type over an audio one, then itunes:image', () => {
    expect(images(enclosures)).toEqual([
      { url: 'https://podcast.townhall.example/art/41.jpg' },
      { url: 'https://podcast.townhall.example/art/40-square.jpg' },
      undefined,
    ]);
  });

  it('takes an Atom enclosure link of an image type, resolved against xml:base', () => {
    expect(images(atomEnclosures)).toEqual([
      { url: 'https://blog.museum.example/media/hall.webp' },
      { url: 'https://cdn.museum.example/2026/11/fridays.jpg' },
      undefined,
    ]);
  });
});

describe('images in the story body', () => {
  it('skips pixels, emoji and avatars, takes the largest srcset candidate and resolves it against the item link', () => {
    expect(images(wordpress)[0]).toEqual({ url: 'https://bakery.example/wp-content/uploads/2026/11/loaves-2048x1366.jpg', width: 2048 });
  });

  it('looks in the description when content:encoded has only a feedburner pixel', () => {
    expect(images(wordpress)[1]).toEqual({ url: 'https://bakery.example/2026/uploads/2026/11/sign.png', width: 800, height: 600 });
  });

  it("finds NPR's photos in its bodies, past its tracking pixel and its src='undefined'", () => {
    const found = images(npr);
    expect(found[0]).toBeUndefined();
    expect(found[1]).toEqual({
      url: 'https://npr.brightspotcdn.com/dims3/default/strip/false/crop/3000x2000+0+0/resize/3000x2000!/quality/85/format/webp/?url=https%3A%2F%2Fnpr-production-npr.s3.us-east-1.amazonaws.com%2Fbrightspot%2F73%2Ff4%2F13d6cbbc4841bdd4a3e5318cbb63%2Fgettyimages-460917708-1.jpg',
    });
    for (const image of found) if (image) expect(image.url).toMatch(/^https:\/\/npr\.brightspotcdn\.com\//);
  });

  it('reads srcsets whose URLs hold commas or no space after a comma, skips a 0-wide spacer and avatars and smileys by class, and unescapes &amp;', () => {
    const body = (img: string) => rss(`<item><title>x</title><link>https://example.com/p/</link><description><![CDATA[${img}]]></description></item>`);
    expect(images(body('<img src="s.jpg" srcset="https://cdn.example/w_300,h_200/a.jpg 300w, https://cdn.example/w_900,h_600/a.jpg 900w">'))).toEqual([
      { url: 'https://cdn.example/w_900,h_600/a.jpg', width: 900 },
    ]);
    expect(images(body('<img srcset="a.jpg 800w,b.jpg 1600w,c.jpg 1200w">'))).toEqual([{ url: 'https://example.com/p/b.jpg', width: 1600 }]);
    expect(images(body('<img srcset="a.jpg, b.jpg 2x">'))).toEqual([{ url: 'https://example.com/p/b.jpg' }]);
    expect(images(body('<img src="t.gif" width="0"><img src="real.jpg">'))).toEqual([{ url: 'https://example.com/p/real.jpg' }]);
    expect(
      images(
        body(
          '<img class="avatar avatar-96" src="/wp-content/uploads/me.jpg"><img class="wp-smiley" src="/wp-includes/images/smilies/simple-smile.png"><img src="a.jpg?w=1&amp;h=2&#38;q=80">',
        ),
      ),
    ).toEqual([{ url: 'https://example.com/p/a.jpg?w=1&h=2&q=80' }]);
  });

  it('resolves against the feed URL when an item has no link, and finds nothing in a feed without images', () => {
    const feed = rss('<item><title>Relative</title><description>&lt;img src="/a.jpg"&gt;</description></item>');
    expect(images(feed, 'https://example.com/news/feed.xml')).toEqual([{ url: 'https://example.com/a.jpg' }]);
    expect(images(atom)).toEqual([undefined, undefined, undefined]);
  });
});

describe('HTML tag boundaries', () => {
  const body = (html: string) => rss(`<item><title>x</title><link>https://example.com/p/</link><description><![CDATA[${html}]]></description></item>`);

  it('reads past a quoted > in an attribute, and ignores tags inside comments, other attributes and scripts', () => {
    expect(images(body('<img alt="a > b" src="real.jpg">'))).toEqual([{ url: 'https://example.com/p/real.jpg' }]);
    expect(images(body('<img alt=\'it&#39;s > that\' src="real.jpg">'))).toEqual([{ url: 'https://example.com/p/real.jpg' }]);
    expect(images(body('<!-- <img src="old.jpg"> --><img src="new.jpg">'))).toEqual([{ url: 'https://example.com/p/new.jpg' }]);
    expect(images(body('<a title="<img src=fake.jpg>">x</a><img src="real.jpg">'))).toEqual([{ url: 'https://example.com/p/real.jpg' }]);
    expect(images(body('<script>var s = "<img src=s.jpg>";</script><STYLE>a{}</STYLE><img src="real.jpg">'))).toEqual([
      { url: 'https://example.com/p/real.jpg' },
    ]);
    expect(images(body('<!-- never closed <img src="a.jpg">'))).toEqual([undefined]);
  });

  it('finds the first real picture in Atom xhtml content, in its parsed elements, against its xml:base', () => {
    expect(images(atomXhtml)).toEqual([{ url: 'https://observatory.example/media/2026/comet-1600.jpg', width: 1600, height: 1067 }, undefined]);
  });
});

describe('srcset candidates', () => {
  const body = (html: string) => rss(`<item><title>x</title><link>https://example.com/p/</link><description><![CDATA[${html}]]></description></item>`);

  it('drops tracking and avatar candidates before ranking, then falls back to src', () => {
    expect(images(body('<img src="photo.jpg" srcset="https://pixel.wp.com/b.gif 4000w, small.jpg 300w">'))).toEqual([
      { url: 'https://example.com/p/small.jpg', width: 300 },
    ]);
    expect(images(body('<img src="photo.jpg" srcset="https://secure.gravatar.com/avatar/a?s=192 2x, data:image/png;base64,AA 3x">'))).toEqual([
      { url: 'https://example.com/p/photo.jpg' },
    ]);
  });
});

describe('XML namespaces and xml:base scopes', () => {
  const at = 'https://feeds.example.org/news/feed.xml';
  const item = (inner: string, attrs = '') =>
    `<rss version="2.0" ${attrs} xmlns:media="http://search.yahoo.com/mrss/"><channel><title>T</title><item><title>x</title><link>https://site.example/story</link>${inner}</item></channel></rss>`;

  it('resolves against the xml:base on the root, on a media:group and on the element itself', () => {
    expect(images(item('<enclosure url="a.jpg" type="image/jpeg"/>', 'xml:base="https://cdn.example/root/"'), at)).toEqual([
      { url: 'https://cdn.example/root/a.jpg' },
    ]);
    expect(images(item('<enclosure xml:base="https://cdn.example/own/" url="a.jpg" type="image/jpeg"/>'), at)).toEqual([
      { url: 'https://cdn.example/own/a.jpg' },
    ]);
    expect(images(item('<media:group xml:base="https://img.example/g/"><media:content url="b.jpg" medium="image"/></media:group>'), at)).toEqual([
      { url: 'https://img.example/g/b.jpg' },
    ]);
    // A relative xml:base resolves against the one above it.
    expect(
      images(item('<media:group xml:base="g/"><media:content xml:base="2026/" url="c.jpg"/></media:group>', 'xml:base="https://cdn.example/r/"'), at),
    ).toEqual([{ url: 'https://cdn.example/r/g/2026/c.jpg' }]);
  });

  it("resolves a logo against its own element's xml:base", () => {
    const rssLogo = '<rss version="2.0"><channel><title>T</title><image xml:base="https://brand.example/"><url>logo.png</url></image></channel></rss>';
    expect(parseNews(rssLogo, { url: at }).logo).toBe('https://brand.example/logo.png');
    const atomLogo = '<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title><logo xml:base="https://brand.example/a/">l.png</logo></feed>';
    expect(parseNews(atomLogo, { url: at }).logo).toBe('https://brand.example/a/l.png');
  });

  it('knows Media RSS and iTunes by their namespace, not their prefix, so an unrelated content or image cannot outrank an enclosure', () => {
    const other =
      '<x:content xmlns:x="urn:example:other" url="https://evil.example/x.jpg" width="9999"/><y:image xmlns:y="urn:example:y" href="https://evil.example/y.jpg"/>';
    expect(images(item(`${other}<enclosure url="https://ok.example/e.jpg" type="image/jpeg"/>`), at)).toEqual([{ url: 'https://ok.example/e.jpg' }]);
    expect(images(item(`<m:thumbnail xmlns:m="http://search.yahoo.com/mrss" url="https://ok.example/t.jpg"/>${other}`), at)).toEqual([
      { url: 'https://ok.example/t.jpg' },
    ]);
    expect(images(item('<pod:image xmlns:pod="http://www.itunes.com/dtds/podcast-1.0.dtd" href="https://ok.example/p.jpg"/>'), at)).toEqual([
      { url: 'https://ok.example/p.jpg' },
    ]);
    // In an Atom entry, a media:content beside the body is still Media RSS, and the body still the body.
    const entry = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/"><title>T</title><entry><title>x</title>
      <media:content url="https://ok.example/m.jpg" medium="video"/><content type="html">&lt;img src="https://ok.example/body.jpg"&gt;</content></entry></feed>`;
    expect(images(entry, at)).toEqual([{ url: 'https://ok.example/body.jpg' }]);
  });
});

describe('the cost of finding images', () => {
  afterEach(() => vi.restoreAllMocks());

  it('normaliseFeed looks for no image at all: a text-only snapshot resolves no URL', () => {
    const urls = vi.spyOn(globalThis, 'URL');
    normaliseFeed('rss', wordpress, { url: 'https://bakery.example/feed/' });
    expect(urls).not.toHaveBeenCalled();
    parseNews(wordpress, { url: 'https://bakery.example/feed/' });
    expect(urls).toHaveBeenCalled();
  });

  it('resolves at most 2,000 URLs a parse, only for the items kept, and none longer than 2,048 characters', () => {
    const urls = vi.spyOn(globalThis, 'URL');
    const many = Array.from(
      { length: 2_000 },
      (_, i) => `<item xml:base="https://cdn.example/${i}/"><title>Item ${i}</title><enclosure url="a.jpg" type="image/jpeg"/></item>`,
    ).join('');
    expect(parseNews(rss(many), { maxItems: 5 }).items.map((i) => i.image?.url)).toEqual([0, 1, 2, 3, 4].map((i) => `https://cdn.example/${i}/a.jpg`));
    expect(urls.mock.calls.length).toBeLessThanOrEqual(5 * 2);
    urls.mockClear();
    const candidates = Array.from({ length: 30_000 }, (_, i) => `c${i}.jpg ${i + 1}w`).join(', ');
    const wide = rss(`<item><title>x</title><link>https://example.com/p/</link><description><![CDATA[<img srcset="${candidates}">]]></description></item>`);
    expect(parseNews(wide).items[0]?.image?.width).toBeLessThanOrEqual(2_000);
    expect(urls.mock.calls.length).toBeLessThanOrEqual(2_000);
    const long = `https://cdn.example/${'a'.repeat(2_048)}.jpg`;
    expect(images(rss(`<item><title>x</title><description>&lt;img src="${long}"&gt;&lt;img src="https://cdn.example/b.jpg"&gt;</description></item>`))).toEqual(
      [{ url: 'https://cdn.example/b.jpg' }],
    );
  });
});

describe('hostile image URLs', () => {
  it('keeps only http and https URLs, whatever the scheme, base or encoding', () => {
    expect(images(hostile)).toEqual([{ url: 'https://hostile.example/ok.jpg', width: 800 }, undefined, undefined]);
    expect(parseNews(hostile).logo).toBeUndefined();
  });

  it('never resolves against a feed URL that is not http or https', () => {
    expect(images(rss('<item><title>x</title><description>&lt;img src="a.jpg"&gt;</description></item>'), 'file:///srv/feed.xml')).toEqual([undefined]);
  });
});

describe('what screens get', () => {
  it('normaliseFeed gives exactly the NewsFeed, with no image or logo URL, though the feed has both', () => {
    const url = 'https://podcast.townhall.example/feed.xml';
    expect(parseNews(enclosures, { url }).logo).toBe('https://podcast.townhall.example/art/logo-1400.png');
    expect(parseNews(enclosures, { url }).items[0]?.image).toEqual({ url: 'https://podcast.townhall.example/art/41.jpg' });
    expect(normaliseFeed('rss', enclosures, { url })).toEqual({
      title: 'Town Hall Hour',
      language: '',
      items: [
        { title: 'Episode 41: the new library', published: '2026-11-19T12:00:00+00:00', source: 'Town Hall Hour' },
        { title: 'Episode 40: budget night', published: '2026-11-12T12:00:00+00:00', source: 'Town Hall Hour' },
        { title: 'Episode 39: bin day changes', published: '2026-11-05T12:00:00+00:00', source: 'Town Hall Hour' },
      ],
    });
  });

  it('holds for every image fixture: none of the URLs parseNews finds is in what normaliseFeed gives', () => {
    for (const [body, url] of [
      [mediaRss, 'https://news.harbour.example/feed'],
      [atomEnclosures, 'https://blog.museum.example/feed.xml'],
      [atomXhtml, 'https://observatory.example/notes/feed.xml'],
      [wordpress, 'https://bakery.example/feed/'],
      [npr, 'https://feeds.npr.org/1001/rss.xml'],
    ] as const) {
      const parsed = parseNews(body, { url });
      const json = JSON.stringify(normaliseFeed('rss', body, { url }));
      const urls = [parsed.logo, ...parsed.items.map((i) => i.image?.url)].filter((u) => u !== undefined);
      expect(urls.length).toBeGreaterThan(0);
      for (const u of urls) expect(json).not.toContain(u);
    }
  });
});
describe('image search cost', () => {
  // 1.8 s on CI for the first five bodies (run 44880983452), against 0.3 s on a laptop; each body may
  // be tried three times, and the later ones make about as much work again.
  it('finds images in linear time in bodies built to make a scanner backtrack, and finds the right ones', { timeout: 120_000 }, () => {
    const base = linearMs();
    const timed = (feed: string, expected: (FeedImage | undefined)[]) => {
      expect(feed.length).toBeLessThanOrEqual(LIMITS.maxBytes);
      expect(images(feed)).toEqual(expected);
      return inLinearTime(() => parseNews(feed), base);
    };
    const body = (html: string, attrs = '') =>
      rss(`<item${attrs}><title>x</title><link>https://example.com/</link><description><![CDATA[${html}<img src="last.jpg">]]></description></item>`);
    const last = [{ url: 'https://example.com/last.jpg' }];
    // An unclosed tag, quote or comment ends the body: a browser drops what follows too.
    // One tag, as a browser reads it: its attributes are "<img" and, last, src.
    expect(timed(body('<img '.repeat(180_000)), last)).toBe(true);
    expect(timed(body(`<img ${'a="b '.repeat(180_000)}>`), last)).toBe(true);
    expect(timed(body(`<p title='${'<img src=x> '.repeat(70_000)}'>`), last)).toBe(true);
    expect(timed(body('<!-- <img src=x> '.repeat(50_000)), [undefined])).toBe(true);
    expect(timed(body('<script></script>'.repeat(50_000)), last)).toBe(true);
    expect(timed(body('<'.repeat(900_000)), last)).toBe(true);
    // Pixels and srcsets: every candidate dropped or ranked in one pass, within the URL budget.
    expect(timed(body('<img src="p.gif" width="1">'.repeat(34_000)), last)).toBe(true);
    expect(timed(body(`<img srcset="${'a.jpg 1w, '.repeat(90_000)}">`), [{ url: 'https://example.com/a.jpg', width: 1 }])).toBe(true);
    expect(timed(body(`<img srcset="a.jpg ${'1'.repeat(150_000)}y">`), [{ url: 'https://example.com/a.jpg' }])).toBe(true);
    expect(timed(body(`<img srcset="a${','.repeat(900_000)}">`), [{ url: 'https://example.com/a' }])).toBe(true);
    expect(timed(body(`<img srcset="a${','.repeat(900_000)}b 1w">`), last)).toBe(true);
    // A base as long as a URL may be, under every one of 40,000 relative candidates.
    const longBase = ` xml:base="https://cdn.example/${'d/'.repeat(1_000)}"`;
    expect(timed(body(`<img srcset="${'b.jpg 2w, '.repeat(40_000)}">`, longBase), [{ url: `https://cdn.example/${'d/'.repeat(1_000)}b.jpg`, width: 2 }])).toBe(
      true,
    );
    // 9,000 items with bases of their own, of which 20 are kept.
    const items = Array.from(
      { length: 9_000 },
      (_, i) => `<item xml:base="https://c.example/${i}/"><title>t</title><enclosure url="a.jpg" type="image/png"/></item>`,
    ).join('');
    expect(
      timed(
        rss(items),
        Array.from({ length: 20 }, (_, i) => ({ url: `https://c.example/${i}/a.jpg` })),
      ),
    ).toBe(true);
  });
});

describe('logo', () => {
  it("takes the RSS channel's <image>, resolved against the feed's URL, and not its itunes:image", () => {
    expect(parseNews(enclosures, { url: 'https://podcast.townhall.example/feed.xml' }).logo).toBe('https://podcast.townhall.example/art/logo-1400.png');
    expect(parseNews(npr).logo).toBe('https://media.npr.org/images/podcasts/primary/npr_generic_image_300.jpg?s=200');
  });

  it('takes an Atom logo, then its icon, and gives none when the feed has neither', () => {
    expect(parseNews(atomEnclosures).logo).toBe('https://blog.museum.example/static/logo-wide.png');
    expect(parseNews(atomEnclosures.replace(/<logo>.*<\/logo>/, '')).logo).toBe('https://blog.museum.example/static/icon.png');
    expect(parseNews(atom).logo).toBeUndefined();
  });
});
