/**
 * What a screen plays, small: an image the spot shows (from the org's files), else its template
 * version's thumbnail drawn by the player (#362), else the spot's name and its template's name on a
 * dark frame. Not a render of the spot's own text: that is the stage's, in the spot editor. `showing`
 * is worked out from the screen's desired manifest, so until the screen reports applying it, the
 * frame says "Updating to" what it will play (as Overview's Playing now counts only screens that took it).
 */
import { sessionBlobPath } from '@signforge/contract';
import { MoonIcon } from 'lucide-react';
import { isRetired } from '~/lib/screen-status';
import type { ScreenView } from '~/lib/screen-types';
import { templateThumbnail } from '~/lib/template-thumbnail';
import { cn } from '~/lib/utils';

export function ScreenThumb({
  screen,
  className,
  size = 'tile',
}: {
  screen: Pick<ScreenView, 'showing' | 'orientation' | 'state' | 'desiredManifestId' | 'reportedManifestId'>;
  className?: string;
  size?: 'tile' | 'row';
}) {
  // A revoked screen plays nothing, whatever its last manifest says.
  const retired = isRetired(screen);
  const s = retired ? null : screen.showing;
  const portrait = screen.orientation === 'portrait';
  const dim = screen.state.kind === 'asleep' ? 'opacity-35' : screen.state.kind === 'unreachable' ? 'opacity-80' : '';
  const drawn = s?.spot?.template ? templateThumbnail(s.spot.template) : undefined;
  const updating = screen.desiredManifestId !== null && screen.reportedManifestId !== screen.desiredManifestId;
  const label = retired
    ? 'Revoked: plays nothing'
    : !s
      ? 'Nothing published yet'
      : s.asleep
        ? 'Asleep for display hours'
        : s.spot
          ? `${updating ? 'Updating to' : 'Playing'}: ${s.spot.name}`
          : 'Nothing to show';
  return (
    <div className={cn('relative flex aspect-video justify-center overflow-hidden bg-stage text-stage-foreground', className)} role="img" aria-label={label}>
      <div className={cn('flex h-full items-center justify-center', portrait ? 'aspect-[9/16]' : 'w-full', dim)}>
        {!s ? (
          <span className={cn('px-3 text-center text-stage-muted-foreground', size === 'row' ? 'text-[10px]' : 'text-sm')}>
            {retired ? 'Revoked' : 'Nothing published yet'}
          </span>
        ) : s.asleep ? (
          <span className={cn('flex items-center gap-1.5 font-semibold text-[#a5b4fc]', size === 'row' ? 'text-[10px]' : 'text-sm')}>
            <MoonIcon className={size === 'row' ? 'size-3' : 'size-4'} aria-hidden /> Asleep
          </span>
        ) : s.spot?.image ? (
          <img src={sessionBlobPath(s.spot.image)} alt="" className="size-full object-cover" loading="lazy" />
        ) : drawn ? (
          <img src={drawn} alt="" className="size-full object-cover" loading="lazy" />
        ) : (
          <span className={cn('flex flex-col items-center gap-1 px-3 text-center', size === 'row' && 'gap-0')}>
            <span className={cn('font-semibold', size === 'row' ? 'line-clamp-2 text-[10px] leading-tight' : 'text-lg leading-snug')}>
              {s.spot?.name ?? 'Nothing to show'}
            </span>
            {size === 'tile' && s.spot?.templateName && <span className="text-xs text-stage-muted-foreground">{s.spot.templateName}</span>}
          </span>
        )}
      </div>
      {updating && s?.spot && !s.asleep && (
        <span
          aria-hidden
          className={cn('absolute inset-x-0 bottom-0 truncate bg-stage/85 px-2 py-0.5 text-stage-foreground', size === 'row' ? 'text-[10px]' : 'text-xs')}
        >
          {size === 'row' ? 'Updating' : `Updating to ${s.spot.name}`}
        </span>
      )}
    </div>
  );
}
