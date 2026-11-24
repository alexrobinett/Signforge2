/**
 * `PlayerStage` (docs/proposals/cms-ui.md, canvas boards Spot editor A and "Stage is the player"):
 * the real player build in an iframe, at the screen's true resolution, scaled to fit or shown at
 * 100%. The CMS serves the build at /player/ (apps/cms README); the store's actions post it the
 * draft (src/state/spot-editor.ts): a spot's, or a playlist's from the playlist editor.
 * Orientation, scale, brand kit and, for a spot bound to data sources, live data or the fallback
 * are in the URL.
 */
import { Choice } from '~/components/ui/choice';
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
    <div role="group" aria-label={label} className="flex rounded-xl bg-stage-control p-1">
      {options.map((o) => (
        <Choice key={o.value} tone="stage" selected={value === o.value} onClick={() => onChange(o.value)} className="h-9 rounded-lg px-3 font-medium">
          {o.label}
        </Choice>
      ))}
    </div>
  );
}

/**
 * An editor's frame, form and stage (#363). The frame is a container: the form and the stage sit side
 * by side only while the editor itself is wide enough for both (`@3xl`, 48rem), whatever the window, so an
 * open agent drawer stacks them as a phone does. Side by side, the form is a fixed width and the stage the
 * rest, sticky and the editor's height, so it stays in view as the form scrolls.
 */
export const EDITOR = '@container flex min-h-(--editor-height) flex-col overflow-clip rounded-xl border';
export const EDITOR_ROW = 'flex flex-1 flex-col @3xl:flex-row';
export const EDITOR_FORM = 'flex min-w-0 flex-col border-b bg-card @3xl:w-sm @3xl:shrink-0 @3xl:border-r @3xl:border-b-0';
export const STAGE_COLUMN = 'flex min-w-0 flex-1 flex-col bg-stage @3xl:sticky @3xl:top-0 @3xl:h-(--editor-height) @3xl:self-start';

export function PlayerStage({
  target,
  kits,
  kitId,
  search,
  onSearch,
  bound = false,
  thumbnail,
}: {
  target: StageShows;
  kits: BrandKitView[];
  kitId: string | null;
  /** The stage's settings, from the editor's URL; `onSearch` changes them there. */
  search: StageSearch;
  onSearch: (next: Partial<StageSearch>) => void;
  /** A spot bound to data sources: the stage offers its data or its fallback values. */
  bound?: boolean;
  /** The spot's template's thumbnail (src/lib/template-thumbnail.ts), shown dimmed until the player draws. */
  thumbnail?: string;
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

  // The frame and what it shows, handed to the store whenever either changes; and whether the frame
  // itself is in view, where alone the player can draw (#342): the room around it may be in view when it is not.
  const frameRef = useCallback(
    (el: HTMLIFrameElement | null) => {
      const frame = el?.contentWindow;
      if (!el || !frame) return;
      const shows = playlistId !== undefined ? { playlistId } : { spotId: spotId ?? '', templateVersionId, fallback };
      attach({ frame, orgId, orientation, brandKitId, ...shows });
      const inView = new IntersectionObserver((entries) => {
        const last = entries.at(-1);
        if (last) see(last.isIntersecting);
      });
      inView.observe(el);
      return () => {
        inView.disconnect();
        see(true);
        attach(null);
      };
    },
    [attach, see, orgId, spotId, playlistId, orientation, templateVersionId, brandKitId, fallback],
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

  // Until the first frame: what a spot of this template looks like, dimmed, and that it is drawing, or why it is not (#363).
  // The status line below says the same to a screen reader.
  const waiting = !playing && !stageError && (
    <div aria-hidden className="absolute inset-0 grid place-items-center bg-stage p-6">
      {thumbnail && <img src={thumbnail} alt="" className="absolute inset-0 size-full object-cover opacity-40" />}
      <span className="relative max-w-prose rounded-xl bg-stage-control px-4 py-2 text-center text-base font-medium text-stage-foreground">
        {holding ? (refusals.length ? refusals.map((r) => `${r}.`).join(' ') : 'Not shown yet: fix the marked field.') : 'Drawing…'}
      </span>
    </div>
  );

  return (
    <section aria-label="Live preview" className="flex min-h-0 min-w-0 flex-1 flex-col gap-3.5 bg-stage px-4 pt-4 pb-7 text-stage-foreground sm:px-8">
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
          <span className="flex items-center gap-2 text-sm text-stage-muted-foreground">
            <label htmlFor="stage-kit">Brand kit</label>
            <NativeSelect id="stage-kit" value={kitId ?? ''} onChange={(e) => onSearch({ kit: e.target.value })} className="min-w-40 text-foreground">
              {kits.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                  {k.isDefault ? ' (default)' : ''}
                </option>
              ))}
            </NativeSelect>
          </span>
        )}
        <span className="ml-auto font-mono text-sm text-stage-muted-foreground">
          {size.w} × {size.h} · {Math.round(shown * 100)}%
        </span>
      </div>
      <p className="inline-flex items-center gap-2 text-sm font-semibold text-stage-foreground">
        <svg width="14" height="14" viewBox="0 0 12 12" aria-hidden="true">
          <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2.2 1.6" />
        </svg>
        The draft, as a screen would show it. Screens play what is published.
      </p>
      {/* The room is sized by the page, never by the frame in it, so Fit can measure it. The frame sits at its top, in the first viewport. */}
      {/* At 100% the room scrolls inside the stage, never past it (at most the editor's height), and what it says while it waits stays in its visible part. */}
      <div className="relative flex min-h-105 flex-1 flex-col @3xl:min-h-0">
        <div ref={roomRef} className={cn('relative min-h-0 flex-1', scale === 'actual' ? 'max-h-(--editor-height) overflow-auto' : 'overflow-hidden')}>
          <div className={scale === 'actual' ? undefined : 'absolute inset-0 flex items-start justify-center'}>
            <div
              className="relative shrink-0 overflow-hidden rounded-sm bg-black ring-1 ring-stage-edge"
              style={{ width: size.w * shown, height: size.h * shown }}
            >
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
              {scale !== 'actual' && waiting}
            </div>
          </div>
        </div>
        {scale === 'actual' && waiting}
      </div>
      <p className="flex flex-wrap justify-between gap-3 text-sm text-stage-muted-foreground">
        {/* The player's own error first: it is what the screen shows, whatever the draft. Said politely as it changes. */}
        <span role="status" aria-live="polite">
          {stageError ? (
            <span className="inline-flex items-center gap-2">
              <TriangleAlertIcon className="size-3.5 text-stage-warning" aria-hidden />
              The player could not show it: {stageError}
            </span>
          ) : holding ? (
            <span className="inline-flex items-center gap-2">
              <TriangleAlertIcon className="size-3.5 text-stage-warning" aria-hidden />
              {playlistId !== undefined
                ? 'Holding the last frame the player could show.'
                : refusals.length
                  ? `${playing ? 'Holding the last valid frame' : 'Not shown yet'}. ${refusals.map((r) => `${r}.`).join(' ')}`
                  : 'Holding the last valid frame until the marked field is fixed.'}
            </span>
          ) : (
            // Drawn, it says so only to assistive tech: the caption above already says what the stage is (#374).
            <span className={playing ? 'sr-only' : undefined}>{playing ? 'Preview ready' : 'Drawing…'}</span>
          )}
        </span>
        <span>{playlistId !== undefined ? 'Plays the loop. Updates as you edit.' : 'Updates as you type.'}</span>
      </p>
    </section>
  );
}
