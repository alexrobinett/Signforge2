/**
 * What a screen should be showing, small: an image the spot shows (from the org's files), else
 * the spot's name on the template's dark frame. Not a render: live rendered thumbnails wait for
 * `PlayerStage` (M3-16).
 */
import { sessionBlobPath } from '@signforge/contract';
import { MoonIcon } from 'lucide-react';
import type { ScreenView } from '~/lib/screen-types';
import { cn } from '~/lib/utils';

export function ScreenThumb({
  screen,
  className,
  size = 'tile',
}: {
  screen: Pick<ScreenView, 'showing' | 'orientation' | 'state'>;
  className?: string;
  size?: 'tile' | 'row';
}) {
  const s = screen.showing;
  const portrait = screen.orientation === 'portrait';
  const dim = screen.state.kind === 'asleep' ? 'opacity-35' : screen.state.kind === 'unreachable' ? 'opacity-80' : '';
  const label = !s ? 'Nothing published yet' : s.asleep ? 'Asleep for display hours' : s.spot ? `Should be showing: ${s.spot.name}` : 'Nothing to show';
  return (
    <div className={cn('relative flex aspect-video justify-center overflow-hidden bg-[#0e0f12] text-white', className)} role="img" aria-label={label}>
      <div className={cn('flex h-full items-center justify-center', portrait ? 'aspect-[9/16]' : 'w-full', dim)}>
        {!s ? (
          <span className={cn('px-3 text-center text-[#b4b6be]', size === 'row' ? 'text-[10px]' : 'text-sm')}>Nothing published yet</span>
        ) : s.asleep ? (
          <span className={cn('flex items-center gap-1.5 font-semibold text-[#a5b4fc]', size === 'row' ? 'text-[10px]' : 'text-sm')}>
            <MoonIcon className={size === 'row' ? 'size-3' : 'size-4'} aria-hidden /> Asleep
          </span>
        ) : s.spot?.image ? (
          <img src={sessionBlobPath(s.spot.image)} alt="" className="size-full object-cover" loading="lazy" />
        ) : (
          <span className={cn('flex flex-col items-center gap-1 px-3 text-center', size === 'row' && 'gap-0')}>
            <span className={cn('font-semibold', size === 'row' ? 'line-clamp-2 text-[10px] leading-tight' : 'text-lg leading-snug')}>
              {s.spot?.name ?? 'Nothing to show'}
            </span>
            {size === 'tile' && s.spot?.template && <span className="font-mono text-[11px] text-[#b4b6be]">{s.spot.template}</span>}
          </span>
        )}
      </div>
    </div>
  );
}
