/**
 * What a spot or a template version looks like, small (#362): the version's thumbnail, drawn by the
 * player ahead of time (scripts/template-thumbnails.ts) for that very version; a spot's own image, at
 * its smallest rendition; else its name or kind on a tile. Decoration beside the name a row or tile
 * already says, so it has no alt text.
 */
import { sessionBlobPath } from '@signforge/contract';
import { useSuspenseQuery } from '@tanstack/react-query';
import { FilmIcon, GlobeIcon } from 'lucide-react';
import type { SpotView, TemplateVersionView } from '~/lib/spots';
import { templateThumbnail } from '~/lib/template-thumbnail';
import { cn } from '~/lib/utils';
import { assetsQuery, templatesQuery } from '~/queries/spots';

const FRAME = 'aspect-video w-full rounded-md bg-muted object-cover';

export function TemplateThumb({ version, className }: { version: Pick<TemplateVersionView, 'key' | 'manifest'>; className?: string }) {
  const drawn = templateThumbnail(version.key);
  return drawn ? (
    <img src={drawn} alt="" width={480} height={270} loading="lazy" className={cn(FRAME, className)} />
  ) : (
    <span aria-hidden className={cn(FRAME, 'grid place-items-center px-2 text-center text-xs font-medium text-muted-foreground', className)}>
      {version.manifest.name}
    </span>
  );
}

/**
 * A spot in a row: its template version's thumbnail, its image, or its kind. Each reads only the
 * query it needs (the page's loader has it ready), so a page with no such spot reads neither.
 */
export function SpotThumb({ orgId, spot, className }: { orgId: string; spot: Pick<SpotView, 'kind' | 'templateVersionId' | 'assetId'>; className?: string }) {
  if (spot.kind === 'template' && spot.templateVersionId) return <VersionThumb orgId={orgId} versionId={spot.templateVersionId} className={className} />;
  if (spot.kind === 'image' && spot.assetId) return <ImageThumb orgId={orgId} assetId={spot.assetId} className={className} />;
  const Icon = spot.kind === 'url' ? GlobeIcon : FilmIcon;
  return (
    <span aria-hidden className={cn(FRAME, 'grid place-items-center text-muted-foreground', className)}>
      <Icon className="size-5" />
    </span>
  );
}

function VersionThumb({ orgId, versionId, className }: { orgId: string; versionId: string; className?: string }) {
  const { templates } = useSuspenseQuery(templatesQuery(orgId)).data;
  const version = templates.flatMap((t) => t.versions).find((v) => v.id === versionId);
  return version ? <TemplateThumb version={version} className={className} /> : <span aria-hidden className={cn(FRAME, className)} />;
}

function ImageThumb({ orgId, assetId, className }: { orgId: string; assetId: string; className?: string }) {
  const { assets } = useSuspenseQuery(assetsQuery(orgId)).data;
  // The smallest rendition: the slot is 64 px wide.
  const smallest = assets.find((a) => a.id === assetId)?.renditions.toSorted((a, b) => a.size - b.size)[0];
  return smallest ? (
    <img src={sessionBlobPath(smallest.sha256)} alt="" loading="lazy" className={cn(FRAME, className)} />
  ) : (
    <span aria-hidden className={cn(FRAME, className)} />
  );
}
