/**
 * `PlayerStage` (docs/proposals/cms-ui.md, canvas boards Spot editor A and "Stage is the player"):
 * the real player build in an iframe, at the screen's true resolution, scaled to fit or shown at
 * 100%. The CMS serves the build at /player/ (apps/cms README); the store's actions post it the
 * draft (src/state/spot-editor.ts): a spot's, or a playlist's from the playlist editor.
 * Orientation, scale, brand kit and, for a spot bound to data sources, live data or the fallback
 * are in the URL.
 */
import { SCREEN_BOX } from '@signforge/contract';
import { TriangleAlertIcon } from 'lucide-react';
import { useCallback } from 'react';
import { NativeSelect } from '~/components/ui/select';
import { useHydrated } from '~/lib/hydrated';
import { PLAYER_URL } from '~/lib/preview';
import type { BrandKitView } from '~/lib/brand-kits';
import { cn } from '~/lib/utils';
import { useAppStore } from '~/state/provider';
import type { StageShows } from '~/state/spot-editor';

type Scale = 'fit' | 'actual';

/** The stage's settings in an editor's URL: `?o=portrait&scale=actual&kit=<id>&data=fallback`. */
export interface StageSearch {
  o?: 'portrait';
  scale?: 'actual';
  kit?: string;
  /** A spot's stage plays its fallback values instead of its sources' data. */
  data?: 'fallback';
}

/** An editor route's `validateSearch`: the stage's settings, anything else dropped. */
export const stageSearch = (s: Record<string, unknown>): StageSearch => ({
  ...(s.o === 'portrait' ? { o: 'portrait' as const } : {}),
  ...(s.scale === 'actual' ? { scale: 'actual' as const } : {}),
  ...(typeof s.kit === 'string' && s.kit ? { kit: s.kit } : {}),
  ...(s.data === 'fallback' ? { data: 'fallback' as const } : {}),
});

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
  kits,
  kitId,
  search,
  onSearch,
  bound = false,
}: {
  target: StageShows;
  kits: BrandKitView[];
  kitId: string | null;
  /** The stage's settings, from the editor's URL; `onSearch` changes them there. */
  search: StageSearch;
  onSearch: (next: Partial<StageSearch>) => void;
  /** A spot bound to data sources: the stage offers its data or its fallback values. */
  bound?: boolean;
}) {
  const attach = useAppStore((s) => s.attachStage);
  const measure = useAppStore((s) => s.measureStage);
  const see = useAppStore((s) => s.seeStage);
  const box = useAppStore((s) => s.spotEditor.stageBox);
  const holding = useAppStore((s) => s.spotEditor.holding);
  const refusals = useAppStore((s) => s.spotEditor.refusals);
  const stageError = useAppStore((s) => s.spotEditor.stageError);
  const playing = useAppStore((s) => s.spotEditor.playing);
  // The player says once that it is listening; a frame in the server's HTML could say it before the store hears.
  const hydrated = useHydrated();
  const { orgId, orientation, brandKitId } = target;
  const spotId = 'spotId' in target ? target.spotId : undefined;
  const templateVersionId = 'spotId' in target ? target.templateVersionId : undefined;
  const playlistId = 'playlistId' in target ? target.playlistId : undefined;
  const fallback = search.data === 'fallback';
  const size = SCREEN_BOX[orientation];
  const fit = box ? Math.min(box.w / size.w, box.h / size.h, 1) : 0;
  const scale: Scale = search.scale ?? 'fit';
  const shown = scale === 'fit' ? fit : 1;

  // The frame and what it shows, handed to the store whenever either changes.
  const frameRef = useCallback(
    (el: HTMLIFrameElement | null) => {
      const frame = el?.contentWindow;
      if (!frame) return;
      const shows = playlistId !== undefined ? { playlistId } : { spotId: spotId ?? '', templateVersionId, fallback };
      attach({ frame, orgId, orientation, brandKitId, ...shows });
      return () => attach(null);
    },
    [attach, orgId, spotId, playlistId, orientation, templateVersionId, brandKitId, fallback],
  );
  // The room the stage has, for scaling to fit; and whether it is in view, where alone the player can draw (#342).
  const roomRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) return;
      const seen = new ResizeObserver(([entry]) => entry && measure({ w: entry.contentRect.width, h: entry.contentRect.height }));
      seen.observe(el);
      const shown = new IntersectionObserver((entries) => {
        const last = entries.at(-1);
        if (last) see(last.isIntersecting);
      });
      shown.observe(el);
      return () => {
        seen.disconnect();
        shown.disconnect();
        see(true);
      };
    },
    [measure, see],
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
          onChange={(o) => onSearch({ o: o === 'portrait' ? 'portrait' : undefined })}
        />
        <Toggle
          label="Scale"
          value={scale}
          options={[
            { value: 'fit', label: 'Fit' },
            { value: 'actual', label: '100%' },
          ]}
          onChange={(v) => onSearch({ scale: v === 'actual' ? 'actual' : undefined })}
        />
        {bound && (
          <Toggle
            label="Data"
            value={fallback ? 'fallback' : 'live'}
            options={[
              { value: 'live', label: 'Live data' },
              { value: 'fallback', label: 'Fallback' },
            ]}
            onChange={(v) => onSearch({ data: v === 'live' ? undefined : 'fallback' })}
          />
        )}
        {kits.length > 0 && (
          <span className="flex items-center gap-2 text-sm text-[#d4d4d4]">
            <label htmlFor="stage-kit">Brand kit</label>
            <NativeSelect
              id="stage-kit"
              value={kitId ?? ''}
              onChange={(e) => onSearch({ kit: e.target.value })}
              className="min-w-40 text-[#101828] dark:text-foreground"
            >
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
        The draft, as a screen would show it. Screens play what is published.
      </p>
      {/* The room is sized by the page, never by the frame in it, so Fit can measure it. The frame sits at its top, in the first viewport. */}
      <div ref={roomRef} className={cn('relative min-h-[420px] flex-1', scale === 'actual' ? 'overflow-auto' : 'overflow-hidden')}>
        <div className={scale === 'actual' ? undefined : 'absolute inset-0 flex items-start justify-center'}>
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
        {/* The player's own error first: it is what the screen shows, whatever the draft. */}
        {stageError ? (
          <span className="inline-flex items-center gap-2">
            <TriangleAlertIcon className="size-3.5 text-[#fdb022]" aria-hidden />
            The player could not show it: {stageError}
          </span>
        ) : holding ? (
          <span className="inline-flex items-center gap-2">
            <TriangleAlertIcon className="size-3.5 text-[#fdb022]" aria-hidden />
            {playlistId !== undefined
              ? 'Holding the last frame the player could show.'
              : refusals.length
                ? `${playing ? 'Holding the last valid frame' : 'Not shown yet'}. ${refusals.map((r) => `${r}.`).join(' ')}`
                : 'Holding the last valid frame until the marked field is fixed.'}
          </span>
        ) : (
          <span>{playing ? 'Drawn by the player your screens run.' : 'Starting the player…'}</span>
        )}
        <span>{playlistId !== undefined ? 'Plays the loop. Updates as you edit.' : 'Updates as you type.'}</span>
      </p>
    </section>
  );
}
