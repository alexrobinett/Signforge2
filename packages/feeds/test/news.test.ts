import { NEWS_SUMMARY_MAX } from '@signforge/contract';
import { XMLParser } from 'fast-xml-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type FeedImage, FeedError, LIMITS, normaliseFeed, parseNews } from '../src/index';
import atom03 from './fixtures/atom-03.xml?raw';
import atom from './fixtures/atom.xml?raw';
import atomEnclosures from './fixtures/atom-enclosures.xml?raw';
import atomXhtml from './fixtures/atom-xhtml.xml?raw';
import bbc from './fixtures/bbc-world.xml?raw';
import dcHttps from './fixtures/dc-https.xml?raw';
import dcUndeclared from './fixtures/dc-undeclared.xml?raw';
import enclosures from './fixtures/enclosures.xml?raw';
import fox from './fixtures/fox-news.xml?raw';
import hostile from './fixtures/hostile.xml?raw';
import leMonde from './fixtures/le-monde.xml?raw';
import mediaRss from './fixtures/media-rss.xml?raw';
import npr from './fixtures/npr-news.xml?raw';
import userland from './fixtures/rss-userland.xml?raw';
import spiegel from './fixtures/spiegel.xml?raw';
import wired from './fixtures/wired.xml?raw';
import wordpress from './fixtures/wordpress.xml?raw';
import { inLinearTime } from './linear';

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
      summary:
        "Trump says he plans to discuss Ukraine during his Asia trip, which contradicts what the White House previously announced. And, Silicon Valley leaders are pushing for Jensen Huang's return to Nvidia.",
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
          summary: 'The Riverside rink opens for the season on Saturday.',
        },
        {
          title: 'Leaf collection: the last pickup for the north side is Nov 20',
          published: '2026-11-14T08:00:00+00:00',
          source: 'Parks & Recreation Department: Updates',
        },
        {
          title: 'Winter hours start December 1',
          published: '2026-11-10T14:00:00+00:00',
          source: 'Parks & Recreation Department: Updates',
          summary: 'Recreation centres close at 8 p.m. through February.',
        },
      ],
    });
  });
});

describe('summaries (#202)', () => {
  const summaries = (descriptions: string[], title = 'Story') =>
    parseNews(rss(descriptions.map((d) => `<item><title>${title}</title><description><![CDATA[${d}]]></description></item>`).join(''))).items.map(
      (i) => i.summary,
    );

  it('reads the description as plain text: tags, scripts and styles dropped, references read, spaces collapsed', () => {
    expect(
      summaries([
        '<p>Crews&nbsp;cleared the <b>north&nbsp;ramp</b> &mdash; reopening at 6&nbsp;p.m.</p><script>track()</script><style>p{}</style><p>Drive &amp; walk&hellip;</p>',
      ]),
    ).toEqual(['Crews cleared the north ramp — reopening at 6 p.m. Drive & walk…']);
  });

  it('leaves out a description that is empty, only markup, or the title again', () => {
    expect(summaries(['', '<img src="a.jpg"><br/>', ' story '], 'Story')).toEqual([undefined, undefined, undefined]);
  });

  it(`cuts a long description on a word at ${NEWS_SUMMARY_MAX} characters, ending in an ellipsis`, () => {
    const [cut] = summaries([`${'word '.repeat(100)}end`]);
    expect(cut!.length).toBeLessThanOrEqual(NEWS_SUMMARY_MAX);
    expect(cut).toMatch(/^(word )+word…$/);
  });

  it('reads an Atom summary, else its content', () => {
    const atomFeed = (body: string) =>
      `<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title><entry><title>Story</title><updated>2026-11-17T12:00:00Z</updated>${body}</entry></feed>`;
    expect(parseNews(atomFeed('<summary type="html">&lt;p&gt;Short one&lt;/p&gt;</summary><content>Long one</content>')).items[0]!.summary).toBe('Short one');
    expect(parseNews(atomFeed('<content type="html">&lt;p&gt;Long one&lt;/p&gt;</content>')).items[0]!.summary).toBe('Long one');
  });

  it('reads a description of unclosed scripts and tags in linear time', () => {
    for (const body of ['<script '.repeat(100_000), '<script>'.repeat(100_000), '<p '.repeat(150_000)])
      expect(inLinearTime(() => parseNews(rss(`<item><title>x</title><description><![CDATA[${body}]]></description></item>`)))).toBe(true);
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
      // A processing instruction is skipped whole: what looks like a comment or a tag inside it is neither.
      rss('<item><title>x</title></item>', '<?x <!-- ?><!DOCTYPE rss SYSTEM "http://evil.example/x.dtd">'),
      rss('<item><title>x</title></item>', '<?x <!-- ?><!DOCTYPE rss [<!ATTLIST rss foo CDATA "bar">]>'),
      rss('<item><title>x</title></item>', '<?x <a ?><!DOCTYPE rss>'),
      // Each kind of markup ends where the parser ends it: `-->` from after `<!--`, `?>` from after `<`.
      `<?xml version="1.0"?><!--><a --><!DOCTYPE rss SYSTEM "http://evil.example/x.dtd">${rss('')}`,
      `<!---><a --><!DOCTYPE rss SYSTEM "http://evil.example/x.dtd">${rss('')}`,
      `<!--><a --><!DOCTYPE rss [<!ATTLIST rss foo CDATA "bar">]>${rss('')}`,
      `<?xml version="1.0"?><?><!DOCTYPE rss SYSTEM "http://evil.example/x.dtd"><?x ?>${rss('')}`,
      // `<!---->` ends at the `-->` that starts right after `<!--`, so the DOCTYPE after it is outside.
      `<?xml version="1.0"?><!----><!DOCTYPE rss SYSTEM "http://evil.example/x.dtd"><!-- -->${rss('')}`,
      // The validator reads `<?> … ?>` as one PI, the parser `<?>` and then a closing tag that ends at its
      // first `>`, quotes and all: so the DOCTYPE after it is read, and refused.
      `<?xml version="1.0"?><?> </a "><!DOCTYPE rss SYSTEM "http://evil.example/x.dtd">" > ?>${rss('')}`,
      `<?xml version="1.0"?><?> </a '><!DOCTYPE rss SYSTEM "http://evil.example/x.dtd">' > ?>${rss('')}`,
      // A CDATA section is skipped whole, and a DOCTYPE the parser would read inside the feed is refused too.
      `<![CDATA[<a]]><!DOCTYPE rss SYSTEM "http://evil.example/x.dtd">${rss('')}`,
      rss('<item><title>x</title></item><!DOCTYPE rss SYSTEM "http://evil.example/x.dtd">'),
    ]) {
      expect(() => parseNews(body)).toThrow(expect.objectContaining({ code: 'doctype' }));
    }
  });

  // fast-xml-parser is pinned (package.json): an upgrade must rerun this test, which is what notices
  // if the parser's loop has moved away from refuseDeclarations' walk.
  // About 0.2 s on a laptop and 5.4 s on CI's runner (run 44896481147): the timeout is set from CI, not the default.
  it('refuses a DOCTYPE exactly when fast-xml-parser would read one, over generated documents', { timeout: 60_000 }, () => {
    // The parser's own reading: an entity the DOCTYPE declares is expanded only if the parser read it.
    const oracle = new XMLParser({ processEntities: true });
    const pieces = [
      '<!--',
      '-->',
      '<!-->',
      '<!--->',
      '<!---->',
      '<?x',
      '<?>',
      '?>',
      ' ?>',
      '<![CDATA[',
      ']]>',
      '<!DOCTYPE rss>',
      '<a>',
      '</a>',
      '</a "',
      '<?></a "',
      '<a',
      '>',
      '"',
      "'",
      '""',
      "''",
      '<a b="',
      "<a b='",
      '"/>',
      "'/>",
      '" ?>',
      "' ?>",
      ' ',
      'x',
    ];
    // A 31-bit LCG in exact integer arithmetic, so the sequence does not repeat within the run.
    let seed = 0x5eed194;
    const random = () => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) & 0x7fffffff;
      return seed / 2 ** 31;
    };
    const seen = new Set<string>();
    const distinct = { read: 0, notRead: 0 };
    for (let n = 0; n < 40_000; n++) {
      const markup = Array.from({ length: 1 + Math.floor(random() * 9) }, () => pieces[Math.floor(random() * pieces.length)]).join('');
      // In the prolog, or inside the feed: the walk has no idea of a root, and neither has the parser's DOCTYPE branch.
      const where = random() < 0.5 ? 'prolog' : 'channel';
      if (seen.has(`${where} ${markup}`)) continue;
      seen.add(`${where} ${markup}`);
      const doc = (doctype: string) => {
        const m = markup.replaceAll('<!DOCTYPE rss>', doctype);
        return where === 'prolog'
          ? `<?xml version="1.0"?>${m}<rss version="2.0"><channel><title>&seen;</title></channel></rss>`
          : `<?xml version="1.0"?><rss version="2.0"><channel>${m}<title>&seen;</title></channel></rss>`;
      };
      let read: boolean;
      try {
        read = JSON.stringify(oracle.parse(doc('<!DOCTYPE rss [<!ENTITY seen "yes">]>'), true)).includes('"yes"');
      } catch {
        continue;
      }
      let code: unknown = 'accepted';
      try {
        parseNews(doc('<!DOCTYPE rss>'));
      } catch (e) {
        code = e instanceof FeedError ? e.code : e;
      }
      if (read) distinct.read++;
      else distinct.notRead++;
      // Where the parser reads a DOCTYPE the feed is refused, and where it does not, no DOCTYPE is claimed.
      expect({ where, markup, doctype: code === 'doctype' }).toEqual({ where, markup, doctype: read });
    }
    // Distinct documents the parser accepts, of each kind, so the agreement means something: with this
    // seed, 32,487 distinct documents, of which the parser accepts 414 that it reads a DOCTYPE in and
    // 2,507 that it reads none in. A walk changed to end a tag, comment or CDATA a character off, to
    // skip no quotes in an opening tag, quotes in a closing tag or one character too many after a
    // quote, or to read CDATA as a tag, fails here.
    expect(seen.size).toBeGreaterThan(32_000);
    expect(distinct.read).toBeGreaterThanOrEqual(390);
    expect(distinct.notRead).toBeGreaterThanOrEqual(2_450);
  });

  it('refuses a prolog whose processing instruction or comment is never closed', () => {
    expect(() => parseNews('<?xml version="1.0"?><?x <!DOCTYPE rss><rss version="2.0"><channel><title>T</title></channel></rss>')).toThrow(
      expect.objectContaining({ code: 'malformed' }),
    );
    expect(() => parseNews('<?xml version="1.0"?><!-- <!DOCTYPE rss><rss version="2.0"><channel><title>T</title></channel></rss>')).toThrow(
      expect.objectContaining({ code: 'malformed' }),
    );
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

  it('picks the smallest Media RSS candidate covering 1920x1080 rather than a 4K copy, and falls back to widest when none covers it', () => {
    const group = (contents: string) =>
      `<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>T</title><item><title>x</title><media:group>${contents}</media:group></item></channel></rss>`;
    // 1920x1080 covers the target box and beats 3840x2160; 640x360 does not cover it.
    expect(
      images(
        group(
          '<media:content url="https://cdn.example/4k.jpg" medium="image" width="3840" height="2160"/>' +
            '<media:content url="https://cdn.example/hd.jpg" medium="image" width="1920" height="1080"/>' +
            '<media:content url="https://cdn.example/sm.jpg" medium="image" width="640" height="360"/>',
        ),
      ),
    ).toEqual([{ url: 'https://cdn.example/hd.jpg', width: 1920, height: 1080 }]);
    // Wide enough (2000) but too short (900) does not cover 1920x1080: 2400x1350 covers and beats 4000x2250.
    expect(
      images(
        group(
          '<media:content url="https://cdn.example/short.jpg" medium="image" width="2000" height="900"/>' +
            '<media:content url="https://cdn.example/huge.jpg" medium="image" width="4000" height="2250"/>' +
            '<media:content url="https://cdn.example/fit.jpg" medium="image" width="2400" height="1350"/>',
        ),
      ),
    ).toEqual([{ url: 'https://cdn.example/fit.jpg', width: 2400, height: 1350 }]);
  });

  it('takes an Atom enclosure link of an image type, resolved against xml:base', () => {
    expect(images(atomEnclosures)).toEqual([
      { url: 'https://blog.museum.example/media/hall.webp' },
      { url: 'https://cdn.museum.example/2026/11/fridays.jpg' },
      undefined,
    ]);
  });
});

// Recorded 2026-11-26. Each CDN's copies were fetched and measured: BBC's 1920 is 1920×1080, Le
// Monde's 2160/1080 is 2160×1080, Fox's upload 1280×720 and Wired's w_1920 1920×1281.
describe('photo renditions (#488)', () => {
  it("asks BBC's ichef for its 1920 copy, not the feed's 240", () => {
    expect(images(bbc)).toEqual([
      { url: 'https://ichef.bbci.co.uk/ace/standard/1920/cpsprodpb/cdd4/live/6fdb6db0-e946-11f1-8b2f-671485cea0be.jpg', width: 1920, height: 1080 },
      { url: 'https://ichef.bbci.co.uk/ace/standard/1920/cpsprodpb/8562/live/1f8d5d00-e8ec-11f1-a094-5fdc692f3e33.jpg', width: 1920, height: 1080 },
    ]);
  });

  it("asks Le Monde for the size that covers the screen at the photo's 2:1, within its crop", () => {
    expect(images(leMonde)).toEqual([
      { url: 'https://img.lemde.fr/2026/11/19/0/0/7056/3528/2160/1080/60/0/416287a_ftp-1-o72zp5beoynf-afp-d7yy2df.jpg', width: 2160, height: 1080 },
      {
        url: 'https://img.lemde.fr/2026/11/24/685/0/8225/4112/2160/1080/60/0/3dac54a_ftp-1-5hapjx1d3y1y-f6c999cf0f7b4c7daded4d5d29e15f89-0-b1859d1fb08648d3bcf4638b6964951a.jpg',
        width: 2160,
        height: 1080,
      },
    ]);
  });

  it('never asks Le Monde for more than its crop, which it would upscale', () => {
    const small = rss(
      '<item xmlns:media="http://search.yahoo.com/mrss/"><title>a</title><media:content width="644" height="322" url="https://img.lemde.fr/2026/11/19/0/0/1000/500/644/322/60/0/a.jpg"/></item>',
    );
    expect(images(small)).toEqual([{ url: 'https://img.lemde.fr/2026/11/19/0/0/1000/500/1000/500/60/0/a.jpg', width: 1000, height: 500 }]);
    const tiny = small.replace('/1000/500/', '/600/300/');
    expect(images(tiny)).toEqual([{ url: 'https://img.lemde.fr/2026/11/19/0/0/600/300/644/322/60/0/a.jpg', width: 644, height: 322 }]);
  });

  it("takes Fox's upload rather than a57's resize, whose larger sizes are upscaled", () => {
    expect(images(fox)).toEqual([
      { url: 'https://static.foxnews.com/foxnews.com/content/uploads/2026/11/myles-garrett-jordan-love-rams-packers.jpg' },
      { url: 'https://static.foxnews.com/foxnews.com/content/uploads/2025/12/fcc-brendan-carr.png' },
    ]);
  });

  it("scales Wired's 5184 upload down to the screen on its CDN, and leaves a 1200 one as it is", () => {
    expect(images(wired)).toEqual([
      { url: 'https://media.wired.com/photos/6b070bb9c3af37e5a5192585/master/w_1920,c_limit/GettyImages-2306835116.jpg', width: 1920, height: 1281 },
      { url: 'https://media.wired.com/photos/6b064e68966159a4e56ddef8/master/pass/The-36-Very-Best-Gifts-for-Dads.jpg', width: 1200, height: 800 },
    ]);
  });

  it("keeps Der Spiegel's 520, which its CDN serves at no other width", () => {
    expect(images(spiegel)).toEqual([{ url: 'https://cdn.prod.www.spiegel.de/images/dfe530bb-2d5c-4016-8869-e1efea6fcba7_w520_r2.08_fpx43.33_fpy45.jpg' }]);
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

  it('drops tracking images by a whole path segment or file name, not a word inside one', () => {
    const body = (html: string) => rss(`<item><title>x</title><link>https://example.com/p/</link><description><![CDATA[${html}]]></description></item>`);
    expect(images(body('<img src="/2026/google-pixel-10-review.jpg"><img src="/b.jpg">'))).toEqual([
      { url: 'https://example.com/2026/google-pixel-10-review.jpg' },
    ]);
    expect(images(body('<img src="/pixels/sunset.jpg">'))).toEqual([{ url: 'https://example.com/pixels/sunset.jpg' }]);
    expect(images(body('<img src="/2026/11/pixel-art-show.jpg">'))).toEqual([{ url: 'https://example.com/2026/11/pixel-art-show.jpg' }]);
    // A publisher's image host that happens to be named pixel.
    expect(images(body('<img src="https://pixel.nymag.com/imgs/daily/vulture/2026/11/20/lead.jpg">'))).toEqual([
      { url: 'https://pixel.nymag.com/imgs/daily/vulture/2026/11/20/lead.jpg' },
    ]);
    for (const tracker of [
      '/pixel.gif',
      '/t/pixel?id=1',
      '/pixel/abc.png',
      '/assets/spacer.png',
      'https://pixel.wp.com/g.gif',
      '/include/images/tracking/npr-rss-pixel.png',
      'https://ad.pixel.example.com/i.gif',
      '/tracking-pixel.gif',
      '/pixel-1x1.gif',
      '/1x1-pixel.png',
      '/spacer_1x1.gif',
      '/img/blank-spacer.gif',
      '/1x1.gif',
    ]) {
      expect(images(body(`<img src="${tracker}"><img src="/real.jpg">`))).toEqual([{ url: 'https://example.com/real.jpg' }]);
    }
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

  it('picks the smallest srcset candidate covering 1920w rather than a wider 4K one, else the widest', () => {
    expect(images(body('<img src="s.jpg" srcset="a.jpg 640w, b.jpg 4096w, c.jpg 2048w, d.jpg 1200w">'))).toEqual([
      { url: 'https://example.com/p/c.jpg', width: 2048 },
    ]);
    expect(images(body('<img src="s.jpg" srcset="a.jpg 640w, b.jpg 1600w, c.jpg 1200w">'))).toEqual([{ url: 'https://example.com/p/b.jpg', width: 1600 }]);
  });

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

  it("gives each kept story its share of the search, so one story's huge srcset cannot cost the others their images", () => {
    const srcset = Array.from({ length: 3_000 }, (_, i) => `c${i}.jpg ${i + 1}w`).join(', ');
    const items = [
      `<item><title>Huge</title><pubDate>Fri, 20 Nov 2026 12:00:00 GMT</pubDate><link>https://example.com/</link><description><![CDATA[<img srcset="${srcset}">]]></description></item>`,
      ...Array.from(
        { length: 19 },
        (_, i) =>
          `<item><title>Story ${i}</title><pubDate>Fri, 20 Nov 2026 11:${String(i).padStart(2, '0')}:00 GMT</pubDate><enclosure url="https://example.com/${i}.jpg" type="image/jpeg"/></item>`,
      ),
    ].join('');
    const found = images(rss(items));
    expect(found[0]?.url).toMatch(/^https:\/\/example\.com\/c\d+\.jpg$/);
    expect(found.slice(1).every((image) => image !== undefined)).toBe(true);
    expect(found).toHaveLength(20);
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
  // be tried five times, each after a pass of its own, and the later ones make about as much work again.
  it('finds images in linear time in bodies built to make a scanner backtrack, and finds the right ones', { timeout: 120_000 }, () => {
    const timed = (feed: string, expected: (FeedImage | undefined)[]) => {
      expect(feed.length).toBeLessThanOrEqual(LIMITS.maxBytes);
      expect(images(feed)).toEqual(expected);
      return inLinearTime(() => parseNews(feed));
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

describe('namespace variants real feeds use', () => {
  it("reads RSS under UserLand's default namespace, with Media RSS under its https namespace", () => {
    const feed = parseNews(userland);
    expect(feed).toMatchObject({ title: 'Scripting News', language: 'en-us' });
    expect(feed.items.map((i) => [i.title, i.published, i.image?.url])).toEqual([
      ['A podcast with a photo', '2026-11-20T15:00:00+00:00', 'https://scripting.example/images/2026/photo.jpg'],
      ['Media RSS under its https namespace', '2026-11-19T15:00:00+00:00', 'https://scripting.example/images/2026/media.jpg'],
    ]);
  });

  it('keeps dc:date under an https dc namespace, or a dc prefix the feed never declares', () => {
    for (const body of [dcHttps, dcUndeclared]) {
      const times = parseNews(body).items.map((i) => i.published);
      expect(times).toHaveLength(2);
      for (const t of times) expect(t).toMatch(/^2026-11-\d\dT\d\d:00:00\+00:00$/);
    }
    expect(parseNews(dcHttps).items[0]?.title).toBe('Library hours change');
    expect(parseNews(dcUndeclared).items[0]?.title).toBe('Snow day');
  });

  it('reads Atom 0.3 as before: titles, language, links and images, though not its own modified and issued dates', () => {
    expect(parseNews(atom03)).toEqual({
      title: 'Old Blog',
      language: 'en',
      items: [{ title: 'Still posting', published: '', source: 'Old Blog', image: { url: 'https://oldblog.example/img/still.jpg' } }],
    });
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
