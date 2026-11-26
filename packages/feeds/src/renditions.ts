import { SCREEN_BOX } from '@signforge/contract';
import type { FeedImage } from './news';

/** The screen box a feed photo aims to cover: choosing a candidate close to this avoids downloading and scaling 4K copies. */
export const TARGET_BOX = SCREEN_BOX.landscape;

/** The width that covers `TARGET_BOX` at a photo's shape, or the box's width when the shape is unknown. */
const coverWidth = ({ width, height }: FeedImage): number =>
  width && height ? Math.max(TARGET_BOX.w, Math.ceil((TARGET_BOX.h * width) / height)) : TARGET_BOX.w;

const sizedTo = (url: string, image: FeedImage, width: number): FeedImage =>
  image.width && image.height ? { url, width, height: Math.round((image.height * width) / image.width) } : { url, width };

/** Widths BBC's ichef serves above its feed's 240, up to its widest; others answer 404 (checked 2026-11-26). */
const BBC_WIDTHS = [1920, 2048];
const BBC_WIDEST = 2560;

/**
 * Image CDNs whose URLs name the size, each rewritten to the size the screen needs, as checked
 * against each CDN on 2026-11-26. These CDNs upscale past the photo's own size (Fox served a 1280
 * photo at 4000, Le Monde a 7056 crop at 9000), which would make a soft photo the template draws as
 * if it were sharp (at its own size, at most 1.25 times), so a rewrite asks only for a size the
 * source is known to have.
 */
const REWRITES: ((href: string, image: FeedImage) => FeedImage | undefined)[] = [
  // BBC: `/ace/standard/<width>/…` at a width from a fixed list; its photos are 2048 or wider.
  (href, image) => {
    const m = /^(https:\/\/ichef\.bbci\.co\.uk\/ace\/standard\/)(\d+)(\/.+)$/.exec(href);
    if (!m) return undefined;
    const want = coverWidth(image);
    const width = BBC_WIDTHS.find((w) => w >= want) ?? BBC_WIDEST;
    return width > Number(m[2]) ? sizedTo(`${m[1]}${width}${m[3]}`, image, width) : undefined;
  },
  // Le Monde: `/<date>/<crop x>/<crop y>/<crop w>/<crop h>/<w>/<h>/<quality>/0/<file>`; the crop is the
  // source's size, so the copy stops there.
  (href) => {
    const m = /^(https:\/\/img\.lemde\.fr\/\d{4}\/\d\d\/\d\d\/\d+\/\d+\/(\d+)\/(\d+)\/)(\d+)\/(\d+)(\/.+)$/.exec(href);
    if (!m) return undefined;
    const now = { url: href, width: Number(m[4]), height: Number(m[5]) };
    const width = Math.min(coverWidth(now), Number(m[2]));
    if (width <= now.width) return undefined;
    const height = Math.min(Math.round((now.height * width) / now.width), Number(m[3]));
    return { url: `${m[1]}${width}/${height}${m[6]}`, width, height };
  },
  // Fox: a57's `/uploads/<yyyy>/<mm>/<w>/<h>/<file>` is a resize of static.foxnews.com's upload, whose
  // photos are 1280×720.
  (href, image) => {
    const m = /^https:\/\/a57\.foxnews\.com\/(static\.foxnews\.com\/foxnews\.com\/content\/uploads\/\d{4}\/\d\d\/)(\d+)\/\d+\/([^/?#]+)(?:[?#].*)?$/.exec(href);
    return m && Number(m[2]) < coverWidth(image) ? { url: `https://${m[1]}${m[3]}` } : undefined;
  },
  // Wired (Condé Nast): `/master/pass/` is the upload itself, up to 5184 wide; `w_<n>,c_limit` scales it
  // down to n and never up.
  (href, image) => {
    const m = /^(https:\/\/media\.wired\.com\/photos\/[^/]+\/master\/)pass(\/.+)$/.exec(href);
    const width = coverWidth(image);
    return m && !(image.width && image.width <= width) ? sizedTo(`${m[1]}w_${width},c_limit${m[2]}`, image, width) : undefined;
  },
];

/**
 * The copy of a feed's chosen photo to fetch: from a CDN in `REWRITES`, the size that covers
 * `TARGET_BOX` (larger for a small photo, smaller for a huge one) within the source's own size;
 * anything else as the feed names it.
 */
export function rendition(image: FeedImage): FeedImage {
  for (const rewrite of REWRITES) {
    const better = rewrite(image.url, image);
    if (better) return better;
  }
  return image;
}
