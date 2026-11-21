import { describe, expect, it } from 'vitest';
import { normaliseFeed, parseNews } from '../src/index';
import atom from './fixtures/atom.xml?raw';
import atomEnclosures from './fixtures/atom-enclosures.xml?raw';
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
  it('normaliseFeed gives the NewsFeed with no image or logo URL in it: those stay on the server', () => {
    for (const body of [mediaRss, enclosures, atomEnclosures, wordpress, npr]) {
      const parsed = parseNews(body);
      const feed = normaliseFeed('rss', body);
      const json = JSON.stringify(feed);
      const urls = [parsed.logo, ...parsed.items.map((i) => i.image?.url)].filter((u) => u !== undefined);
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) expect(json).not.toContain(url);
      expect(Object.keys(feed).sort()).toEqual(['items', 'language', 'title']);
      expect(feed.items.map((i) => i.title)).toEqual(parsed.items.map((i) => i.title));
    }
  });
});

describe('image search cost', () => {
  it('finds images in linear time in bodies built to make a scanner backtrack', () => {
    const base = linearMs();
    const bodies = [
      '<img '.repeat(180_000),
      '<img src="p.gif" width="1">'.repeat(34_000),
      `<img ${'a="b '.repeat(180_000)}>`,
      `<img srcset="${'a.jpg 1w, '.repeat(90_000)}">`,
      `<img srcset="a.jpg ${'1'.repeat(150_000)}y">`,
    ];
    for (const html of bodies) {
      const feed = rss(`<item><title>x</title><link>https://example.com/</link><description><![CDATA[${html}]]></description></item>`);
      expect(inLinearTime(() => parseNews(feed), base)).toBe(true);
    }
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
