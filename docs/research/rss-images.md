# Images in RSS and Atom feeds: how to find them, and how to get them to a screen safely

Research for the template set's feed photos (#189), 2026-11-21. `packages/feeds` finds the images as below (#194); fetching and storing them (#195) and showing them (#196) follow it.

## Where feeds put an item's image

There is no single standard. Real feeds use one or more of these, so the parser tries them in order and takes the first usable image.

1. **Media RSS** (`xmlns:media="http://search.yahoo.com/mrss/"`, spec 1.5.1, rssboard.org/media-rss).
   - `<media:content url width height medium="image" type="image/jpeg">`, directly on the item or inside `<media:group>` (several sizes of one picture). Pick the widest image, preferring `medium="image"` or a `type` starting `image/`; skip video and audio entries.
   - `<media:thumbnail url width height>`, on the item, inside `media:content` or inside `media:group`. Often small (YouTube: 480×360; some news sites: 144 px). Fine for a list thumbnail, too small for a lead photo.
2. **RSS 2.0 `<enclosure url length type>`** (rssboard.org RSS 2.0). Use only when `type` starts with `image/`: podcasts and some news feeds put audio or video there first. The spec is unclear on how many an item may have, so read all of them.
3. **Atom `<link rel="enclosure" href type length>`** (RFC 4287 §4.2.7.2), with the same `image/` rule. `length` is advisory.
4. **`<itunes:image href>`** on the item (podcast feeds).
5. **The first `<img>` in the item body**: `content:encoded`, then `description` (RSS), or `content`, then `summary` (Atom). The body is escaped HTML or CDATA, so it needs an HTML pass, not XML. Skip:
   - tracking pixels and spacers: width or height ≤ 2, or a known path such as `/pixel`, `feedburner`, `feeds.feedburner.com/~r/`;
   - avatars and emoji: `gravatar.com`, `s.w.org/images/core/emoji`;
   - `data:` URLs.

   Take the largest `srcset` candidate. Resolve a relative `src` against `xml:base`, then the item's `<link>`, then the feed URL. WordPress feeds usually have images only here. The NPR fixture we already have (`packages/feeds/test/fixtures/npr-news.xml`) carries 10 body `<img>` tags and no Media RSS or enclosure, so this step matters.
6. **Nothing.** The template shows the source's monogram or a bigger headline (the canvas boards already do).

**Not in v1: the article page's `og:image`.** Some readers (Piano ESP, ScreenCloud through Embedly) fetch the article and read its `og:image` when the feed has no image. That is one more request per item per poll. Google News items redirect and block it. It also makes the server crawl third-party sites. Leave it for later, opt-in per source, cached for days.

**Channel image.** `<channel><image><url>` (RSS) and `<logo>` / `<icon>` (Atom) are the publisher's logo. They make a better "no image" fallback than the monogram, and are a separate field from the item image.

## Where the image goes

- `parseNews` (in `packages/feeds`, not the contract) gives each item an `image?: { url, width?, height? }`, the source URL as found, and the feed a `logo?`. The contract holds the shapes a screen sees, and a screen never sees these: `normaliseFeed`, which the poller stores, leaves them out.
- What a screen sees is the stored, checked copy: the snapshot names each image by hash, and the template gets it as an asset (`data-sf-src` on a list row, an image property allowed in list items). That shape joins the contract when screens get images.

## Getting the image to the screen

Screens and templates have no network, and a feed's image URL is untrusted input. So the **server** fetches, checks and stores, and the screen only ever gets a blob through the sync, as it gets manifest files.

- **Fetching rules:** the same as for feed URLs (`feedUrlProblem`, then every redirect, then the resolved addresses: no private ranges). https only. Many feeds still serve `http://` images: try the same URL over https once, else drop the image. A size cap before reading the body (for example 8 MB). A content type of `image/jpeg`, `png`, `webp` or `avif`, confirmed by sniffing the bytes, not by the header or extension (ScreenCloud notes WebP failing to extract; decode-check it).
- **Checking and resizing**, as uploads are (`packages/media`: `image-info`, `renditions`): a decode check, resized to fit `SCREEN_BOX`, plus the small thumbnail rendition #169 asks for (contrast checks and list thumbnails). Store by content hash, so one picture used by many feeds or orgs is stored once per org.
- **Cost per poll:** polls run every 5 minutes on a Worker with 30 s of CPU shared with other orgs' sources. So:
  - fetch only images for items that will be shown (the first `maxItems`, at most 10 per source);
  - remember URL → hash with the response's `ETag` / `Last-Modified` and skip unchanged URLs;
  - run the resize off the poll path, through the same queue or binding uploads use;
  - a source keeps its last good images when a fetch fails.
- **Sync and player:** the snapshot lists the hashes it uses; the sync sends missing blobs; the player pins them for as long as a snapshot it holds refers to them (as for manifest files) and evicts afterwards. A story whose image did not arrive plays as a story with no image.
- **Templates:** an item's image is an asset URL or empty, never a remote URL. Contrast over a photo uses the thumbnail (`readableOver`), as photo-promo does.

## Test fixtures to add

- A Media RSS feed with `media:group` (several widths) and a video entry first.
- An RSS feed with an audio enclosure and an image enclosure.
- An Atom feed with `link rel="enclosure"` of each type.
- WordPress-style `content:encoded` with a tracking pixel, an emoji, a relative `src`, a `srcset` and the real image.
- A feed with no images at all, and one with a channel `<image>`.
- Hostile cases: `data:` URLs, `file:` and `http://localhost`, an IP literal, a redirect to a private address, a 50 MB body, an SVG (refused: script).

## Decision

Publishers own their photos, and showing them on screens in a business is a different use from a feed reader. The owner decided (2026-11-21): **feed photos are on by default, with a switch on each source to turn them off.** The fetching rules above apply either way.

## Sources

- [Media RSS Specification](https://rssboard.org/media-rss)
- [RSS 2.0 Specification](https://www.rssboard.org/rss-2-0) and [RSS enclosure](https://en.wikipedia.org/wiki/RSS_enclosure)
- [RFC 4287, The Atom Syndication Format](https://www.rfc-editor.org/rfc/rfc4287)
- [How SocialBu finds images in RSS feeds](https://help.socialbu.com/articles/4409513-how-socialbu-finds-images-in-your-rss-feed)
- [FeedBlitz: what determines the featured image](https://feedblitz.freshdesk.com/support/solutions/articles/43000633478-what-determines-the-featured-image-)
- [ScreenCloud: RSS app shows the wrong image](https://help.screencloud.com/s/article/RSS-Feed-App-Why-Is-the-Feed-Pulling-or-Showing-the-Wrong-Image-From-the-Source)
- [Piano ESP: finding an image for a story](https://docs.piano.io/en/subscriptions/how-esp-finds-an-image-to-illustrate-a-story-when-a-story-doesn-t-have-one)
- [Fedora magfeed: video enclosures first leave a blank thumbnail](https://lists.fedoraproject.org/archives/list/websites@lists.fedoraproject.org/message/72PFRNZIA7WZQCCD5FINZIAMGRBJAHED/)
