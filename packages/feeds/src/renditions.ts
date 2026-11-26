import { SCREEN_BOX } from '@signforge/contract';

const TARGET = SCREEN_BOX.landscape;

/**
 * Image CDNs whose URLs name the size, each rewritten to the size the screen needs, as checked
 * against each CDN on 2026-11-26. These CDNs upscale past the photo's own size (Fox served a 1280
 * photo at 4000, Le Monde a 7056 crop at 9000), which would make a soft photo the template draws as
 * if it were sharp (at its own size, at most 1.25 times), so a rewrite asks only for a size the
 * source is known to have, or one the CDN never upscales to.
 */
const REWRITES: ((href: string) => string | undefined)[] = [
  // BBC: `/ace/standard/<width>/…`, its feed's at 240. It serves 1920, 2048 and 2560 but not 1000 or
  // 2160; whether it upscales a photo narrower than 1920 is not known.
  (href) => {
    const m = /^(https:\/\/ichef\.bbci\.co\.uk\/ace\/standard\/)(\d+)(\/.+)$/.exec(href);
    return m && Number(m[2]) < TARGET.w ? `${m[1]}${TARGET.w}${m[3]}` : undefined;
  },
  // Le Monde: `/<date>/<crop x>/<crop y>/<crop w>/<crop h>/<w>/<h>/<quality>/0/<file>`; the crop is the
  // source's size, so the copy stops there.
  (href) => {
    const m = /^(https:\/\/img\.lemde\.fr\/\d{4}\/\d\d\/\d\d\/\d+\/\d+\/(\d+)\/(\d+)\/)(\d+)\/(\d+)(\/.+)$/.exec(href);
    if (!m) return undefined;
    const [w, h] = [Number(m[4]), Number(m[5])];
    const width = Math.min(Math.max(TARGET.w, Math.ceil((TARGET.h * w) / h)), Number(m[2]));
    if (width <= w) return undefined;
    return `${m[1]}${width}/${Math.min(Math.round((h * width) / w), Number(m[3]))}${m[6]}`;
  },
  // Fox: a57's `/uploads/<yyyy>/<mm>/<w>/<h>/<file>` is a resize of static.foxnews.com's upload, which
  // was 1280×720 for 59 of 60 sampled (one 2560×1440, which the store scales down).
  (href) => {
    const m = /^https:\/\/a57\.foxnews\.com\/(static\.foxnews\.com\/foxnews\.com\/content\/uploads\/\d{4}\/\d\d\/)(\d+)\/\d+\/([^/?#]+)(?:[?#].*)?$/.exec(href);
    return m && Number(m[2]) < TARGET.w ? `https://${m[1]}${m[3]}` : undefined;
  },
  // Wired (Condé Nast): `/master/pass/` is the upload itself, up to 5184 wide; `w_<n>,c_limit` scales it
  // down to n and never up.
  (href) => {
    const m = /^(https:\/\/media\.wired\.com\/photos\/[^/]+\/master\/)pass(\/.+)$/.exec(href);
    return m ? `${m[1]}w_${TARGET.w},c_limit${m[2]}` : undefined;
  },
];

/**
 * The URL of a copy at the size that covers the screen (larger for a small photo, smaller for a
 * huge one), within the source's own size, when `url` is from a CDN in `REWRITES`. The photo keeps
 * the feed's URL as its identity; this is only where it is fetched from first.
 */
export function rendition(url: string): string | undefined {
  for (const rewrite of REWRITES) {
    const better = rewrite(url);
    if (better) return better;
  }
  return undefined;
}
