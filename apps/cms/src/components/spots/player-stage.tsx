/**
 * `PlayerStage` (docs/proposals/cms-ui.md, canvas boards Spot editor A and "Stage is the player"):
 * the real player build in an iframe, at the screen's true resolution, scaled to fit or shown at
 * 100%. The CMS serves the build at /player/ (apps/cms README); the store's actions post it the
 * draft (src/state/spot-editor.ts). Orientation, scale and brand kit are in the URL.
 */
import { SCREEN_BOX } from '@signforge/contract';
import { TriangleAlertIcon } from 'lucide-react';
import { useCallback } from 'react';
import { NativeSelect } from '~/components/ui/select';
import { useHydrated } from '~/lib/hydrated';
import type { BrandKitView } from '~/lib/spots';
import { cn } from '~/lib/utils';
import { useAppStore } from '~/state/provider';
import type { StageTarget } from '~/state/spot-editor';

type Orientation = 'landscape' | 'portrait';
type Scale = 'fit' | 'actual';

const PLAYER_URL = '/player/index.html?source=preview';

function Toggle<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, as the canvas draws it; a fieldset would need a legend shown.
    <div role="group" aria-label={label} className="flex rounded-[10px] bg-[#2a2a2d] p-[3px]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'h-[38px] rounded-lg px-3 font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-[#8fa3ff]',
            value === o.value ? 'bg-white text-[#101828]' : 'text-[#d4d4d4] hover:text-white',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function PlayerStage({
  target,
  scale,
  kits,
  kitId,
  onOrientation,
  onScale,
  onKit,
}: {
  target: Omit<StageTarget, 'frame'>;
  scale: Scale;
  kits: BrandKitView[];
  kitId: string | null;
  onOrientation: (o: Orientation) => void;
  onScale: (s: Scale) => void;
  onKit: (id: string) => void;
}) {
  const attach = useAppStore((s) => s.attachStage);
  const measure = useAppStore((s) => s.measureStage);
  const box = useAppStore((s) => s.spotEditor.stageBox);
  const holding = useAppStore((s) => s.spotEditor.holding);
  const stageError = useAppStore((s) => s.spotEditor.stageError);
  const playing = useAppStore((s) => s.spotEditor.playing);
  // The player says once that it is listening; a frame in the server's HTML could say it before the store hears.
  const hydrated = useHydrated();
  const { orgId, spotId, orientation, templateVersionId, brandKitId } = target;
  const size = SCREEN_BOX[orientation];
  const fit = box ? Math.min(box.w / size.w, box.h / size.h, 1) : 0;
  const shown = scale === 'fit' ? fit : 1;

  // The frame and what it shows, handed to the store whenever either changes.
  const frameRef = useCallback(
    (el: HTMLIFrameElement | null) => {
      const frame = el?.contentWindow;
      if (!frame) return;
      attach({ frame, orgId, spotId, orientation, templateVersionId, brandKitId });
      return () => attach(null);
    },
    [attach, orgId, spotId, orientation, templateVersionId, brandKitId],
  );
  // The room the stage has, for scaling to fit.
  const roomRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) return;
      const seen = new ResizeObserver(([entry]) => entry && measure({ w: entry.contentRect.width, h: entry.contentRect.height }));
      seen.observe(el);
      return () => seen.disconnect();
    },
    [measure],
  );

  return (
    <section aria-label="Live preview" className="flex min-w-0 flex-1 flex-col gap-3.5 bg-[#18181a] px-4 pt-4 pb-7 text-[#e8e8e8] sm:px-8">
      <div className="flex flex-wrap items-center gap-3">
        <Toggle
          label="Orientation"
          value={orientation}
          options={[
            { value: 'landscape', label: 'Landscape' },
            { value: 'portrait', label: 'Portrait' },
          ]}
          onChange={onOrientation}
        />
        <Toggle
          label="Scale"
          value={scale}
          options={[
            { value: 'fit', label: 'Fit' },
            { value: 'actual', label: '100%' },
          ]}
          onChange={onScale}
        />
        {kits.length > 0 && (
          <span className="flex items-center gap-2 text-sm text-[#d4d4d4]">
            <label htmlFor="stage-kit">Brand kit</label>
            <NativeSelect id="stage-kit" value={kitId ?? ''} onChange={(e) => onKit(e.target.value)} className="min-w-40 text-[#101828] dark:text-foreground">
              {kits.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                  {k.isDefault ? ' (default)' : ''}
                </option>
              ))}
            </NativeSelect>
          </span>
        )}
        <span className="ml-auto font-mono text-[13px] text-[#b8b8b8]">
          {size.w} × {size.h} · {Math.round(shown * 100)}%
        </span>
      </div>
      <p role="status" className="inline-flex items-center gap-2 text-sm font-semibold text-[#f2f4f7]">
        <svg width="14" height="14" viewBox="0 0 12 12" aria-hidden="true">
          <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2.2 1.6" />
        </svg>
        Draft. Not on any screen.
      </p>
      {/* The room is sized by the page, never by the frame in it, so Fit can measure it. */}
      <div ref={roomRef} className={cn('relative min-h-[420px] flex-1', scale === 'actual' ? 'overflow-auto' : 'overflow-hidden')}>
        <div className={scale === 'actual' ? undefined : 'absolute inset-0 flex items-center justify-center'}>
          <div className="shrink-0 overflow-hidden rounded-sm bg-black ring-1 ring-[#3a3a3d]" style={{ width: size.w * shown, height: size.h * shown }}>
            {/* A new frame per orientation: the player sizes itself to its window when it starts. */}
            {hydrated && (
              <iframe
                key={orientation}
                ref={frameRef}
                title={`Preview, ${orientation}, as screens show it`}
                src={PLAYER_URL}
                width={size.w}
                height={size.h}
                className="origin-top-left border-0"
                style={{ transform: `scale(${shown})`, visibility: box ? 'visible' : 'hidden' }}
              />
            )}
          </div>
        </div>
      </div>
      <p className="flex flex-wrap justify-between gap-3 text-[13px] text-[#c8c8c8]">
        {holding ? (
          <span className="inline-flex items-center gap-2">
            <TriangleAlertIcon className="size-3.5 text-[#fdb022]" aria-hidden />
            Holding the last valid frame until the marked field is fixed.
          </span>
        ) : stageError ? (
          <span className="inline-flex items-center gap-2">
            <TriangleAlertIcon className="size-3.5 text-[#fdb022]" aria-hidden />
            The player could not show it: {stageError}
          </span>
        ) : (
          <span>{playing ? 'Drawn by the player your screens run.' : 'Starting the player…'}</span>
        )}
        <span>Updates as you type.</span>
      </p>
    </section>
  );
}
