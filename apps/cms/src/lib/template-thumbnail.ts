/**
 * A base template's thumbnail, drawn by the player ahead of time (scripts/template-thumbnails.ts) at
 * the template's current version: what a spot of it looks like before the stage has drawn it (#363).
 * An org's own template, or one not drawn yet, has none.
 */
import thumbnails from './template-thumbnails.json';

const DRAWN: Record<string, string> = thumbnails;

/**
 * The thumbnail of a template version as manifests and spots name it (`base/clock@1.2.4`): only when
 * the player drew that very version, so an older spot never shows a newer version's artwork (#362).
 */
export function templateThumbnail(key: string): string | undefined {
  const m = /^base\/([^@]+)@(.+)$/.exec(key);
  return m?.[1] && DRAWN[m[1]] === m[2] ? `/template-thumbnails/${m[1]}.webp` : undefined;
}
