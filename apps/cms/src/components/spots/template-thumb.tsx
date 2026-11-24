/**
 * What a spot or a template looks like, small (#362): a base template's thumbnail, drawn by the
 * player ahead of time (scripts/template-thumbnails.ts); a spot's own image; else its name or kind on
 * a tile. Decoration beside the name a row or tile already says, so it has no alt text.
 */
import { sessionBlobPath } from '@signforge/contract';
import { FilmIcon, GlobeIcon } from 'lucide-react';
import type { AssetView } from '~/lib/assets';
import type { SpotView, TemplateView } from '~/lib/spots';
import { templateThumbnail } from '~/lib/template-thumbnail';
import { cn } from '~/lib/utils';

const FRAME = 'aspect-video w-full rounded-md bg-muted object-cover';

export function TemplateThumb({ template, className }: { template: TemplateView; className?: string }) {
  const drawn = templateThumbnail(template);
  return drawn ? (
    <img src={drawn} alt="" width={480} height={270} loading="lazy" className={cn(FRAME, className)} />
  ) : (
    <span aria-hidden className={cn(FRAME, 'grid place-items-center px-2 text-center text-xs font-medium text-muted-foreground', className)}>
      {template.name}
    </span>
  );
}

/** A spot in a row: its template's thumbnail, its image, or its kind. */
export function SpotThumb({
  spot,
  templateOf,
  assets,
  className,
}: {
  spot: Pick<SpotView, 'kind' | 'templateVersionId' | 'assetId'>;
  templateOf: Map<string, TemplateView>;
  assets: Map<string, AssetView>;
  className?: string;
}) {
  const template = templateOf.get(spot.templateVersionId ?? '');
  if (template) return <TemplateThumb template={template} className={className} />;
  const image = spot.kind === 'image' ? assets.get(spot.assetId ?? '') : undefined;
  if (image) return <img src={sessionBlobPath(image.sha256)} alt="" loading="lazy" className={cn(FRAME, className)} />;
  const Icon = spot.kind === 'url' ? GlobeIcon : FilmIcon;
  return (
    <span aria-hidden className={cn(FRAME, 'grid place-items-center text-muted-foreground', className)}>
      <Icon className="size-5" />
    </span>
  );
}
