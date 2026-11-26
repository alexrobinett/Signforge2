/**
 * The kit page's previews (canvas board Idea 11): the org's own template spots, each on the real
 * player in an iframe at 1920 × 1080, scaled to the column, wearing the draft kit. The store posts
 * each player its spot (src/state/brand-kits.ts) and re-themes them as a colour changes.
 */
import { SCREEN_BOX } from '@signforge/contract';
import { Link } from '@tanstack/react-router';
import { useCallback } from 'react';
import { useHydrated } from '~/lib/hydrated';
import { useWidthRef } from '~/lib/measured';
import { PLAYER_URL } from '~/lib/preview';
import type { SpotView } from '~/lib/spots';
import { useAppStore } from '~/state/provider';

const SIZE = SCREEN_BOX.landscape;

function KitPreview({ orgId, kitId, spot, what }: { orgId: string; kitId: string; spot: SpotView; what: string }) {
  const attach = useAppStore((s) => s.attachKitPreview);
  const measure = useAppStore((s) => s.measureKitPreview);
  const width = useAppStore((s) => s.brandKits.previewWidth);
  const status = useAppStore((s) => s.brandKits.previews[spot.id]);
  // The player says once that it is listening; a frame in the server's HTML could say it before the store hears.
  const hydrated = useHydrated();
  const scale = width ? width / SIZE.w : 0;
  const { id: spotId, templateVersionId } = spot;

  const frameRef = useCallback(
    (el: HTMLIFrameElement | null) => {
      const frame = el?.contentWindow;
      if (!frame || !templateVersionId) return;
      attach(spotId, { frame, orgId, kitId, spotId, templateVersionId });
      return () => attach(spotId, null);
    },
    [attach, orgId, kitId, spotId, templateVersionId],
  );
  const boxRef = useWidthRef(measure);

  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1.5">
      <div ref={boxRef} className="relative aspect-video overflow-hidden rounded-lg bg-letterbox ring-1 ring-border">
        {hydrated && (
          <iframe
            ref={frameRef}
            title={`${spot.name}, with this kit, as screens show it`}
            src={PLAYER_URL}
            width={SIZE.w}
            height={SIZE.h}
            className="absolute top-0 left-0 origin-top-left border-0"
            style={{ transform: `scale(${scale})`, visibility: width ? 'visible' : 'hidden' }}
          />
        )}
      </div>
      <figcaption className="flex flex-wrap justify-between gap-x-2 text-meta">
        <Link to="/spots/$spotId" params={{ spotId: spot.id }} className="font-semibold underline-offset-4 hover:underline">
          {spot.name}
        </Link>
        <span className="text-muted-foreground">
          {status?.error ? `The player could not show it: ${status.error}` : status?.refused ? `Not shown with this kit: ${status.refused}` : what}
        </span>
      </figcaption>
    </figure>
  );
}

export function KitPreviews({
  orgId,
  kitId,
  spots,
  total,
  whatOf,
}: {
  orgId: string;
  kitId: string;
  spots: SpotView[];
  /** How many template spots the org has. */
  total: number;
  whatOf: (s: SpotView) => string;
}) {
  return (
    <section aria-labelledby="kit-previews" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="kit-previews" className="text-base font-semibold">
          Your spots, with this kit
        </h2>
        {spots.length > 0 && (
          <span className="text-meta text-muted-foreground">
            {spots.length} of {total} · each one is the player your screens run, re-theming as you edit
          </span>
        )}
      </div>
      {spots.length ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(280px,100%),1fr))] gap-4">
          {spots.map((s) => (
            <KitPreview key={s.id} orgId={orgId} kitId={kitId} spot={s} what={whatOf(s)} />
          ))}
        </div>
      ) : (
        <p className="rounded-xl border border-dashed bg-card/50 p-6 text-sm text-muted-foreground">
          Spots made from templates show here, wearing this kit as you edit it.{' '}
          <Link to="/spots" className="text-primary underline underline-offset-4">
            Make a spot
          </Link>
          .
        </p>
      )}
    </section>
  );
}
