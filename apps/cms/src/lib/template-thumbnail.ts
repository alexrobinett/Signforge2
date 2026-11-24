/**
 * A base template's thumbnail, drawn by the player ahead of time (scripts/template-thumbnails.ts) at
 * the template's current version: what a spot of it looks like before the stage has drawn it (#363).
 * An org's own template, or one not drawn yet, has none.
 */
import type { TemplateView } from './spots';
import thumbnails from './template-thumbnails.json';

const DRAWN: Record<string, string> = thumbnails;

export const templateThumbnail = (template: Pick<TemplateView, 'owner' | 'key'>): string | undefined =>
  template.owner === 'base' && template.key in DRAWN ? `/template-thumbnails/${template.key}.webp` : undefined;

/** The same, for a template as a manifest names it: `base/clock@1.2.4` (#362). */
export function manifestTemplateThumbnail(template: string): string | undefined {
  const key = /^base\/([^@]+)@/.exec(template)?.[1];
  return key ? templateThumbnail({ owner: 'base', key }) : undefined;
}
