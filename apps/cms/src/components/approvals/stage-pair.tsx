/**
 * The stage split (#115, canvas board AgentApprovals): a pinned spot on the real player twice, as
 * screens have it now and as approving publishes it, each scaled to its column. The store posts each
 * player its spot (src/state/approvals.ts).
 */
import { SCREEN_BOX } from '@signforge/contract';
import { useCallback } from 'react';
import type { SpotStage } from '~/lib/approvals';
import { useHydrated } from '~/lib/hydrated';
import { useWidthRef } from '~/lib/measured';
import { PLAYER_URL } from '~/lib/preview';
import type { SpotView } from '~/lib/spots';
import { cn } from '~/lib/utils';
import { useAppStore } from '~/state/provider';

const SIZE = SCREEN_BOX.landscape;

function Player({ stageKey, orgId, spot, label, after }: { stageKey: string; orgId: string; spot: SpotView; label: string; after: boolean }) {
  const attach = useAppStore((s) => s.attachApprovalStage);
  const measure = useAppStore((s) => s.measureApprovalStage);
  const width = useAppStore((s) => s.approvals.stageWidth);
  const status = useAppStore((s) => s.approvals.stages[stageKey]);
  // The player says once that it is listening; a frame in the server's HTML could say it before the store hears.
  const hydrated = useHydrated();
  const scale = width ? width / SIZE.w : 0;

  const frameRef = useCallback(
    (el: HTMLIFrameElement | null) => {
      const frame = el?.contentWindow;
      if (!frame) return;
      attach(stageKey, { frame, orgId, spot });
      return () => attach(stageKey, null);
    },
    [attach, stageKey, orgId, spot],
  );
  const boxRef = useWidthRef(measure);
  return (
    <div ref={boxRef} className={cn('relative aspect-video overflow-hidden rounded-md bg-black', after ? 'ring-2 ring-primary' : 'ring-1 ring-border')}>
      {hydrated && (
        <iframe
          ref={frameRef}
          title={label}
          src={PLAYER_URL}
          width={SIZE.w}
          height={SIZE.h}
          className="absolute top-0 left-0 origin-top-left border-0"
          style={{ transform: `scale(${scale})`, visibility: width ? 'visible' : 'hidden' }}
        />
      )}
      {status?.error && (
        <p className="absolute inset-x-0 bottom-0 bg-black/80 px-3 py-2 text-xs text-white" role="status">
          The player cannot show it: {status.error}
        </p>
      )}
    </div>
  );
}

export function StagePair({ requestId, orgId, stage, screens }: { requestId: string; orgId: string; stage: SpotStage; screens: number }) {
  const { now, after } = stage;
  const key = `${requestId}:${after.id}`;
  return (
    <div className="grid max-w-[900px] grid-cols-[repeat(auto-fit,minmax(min(360px,100%),1fr))] gap-4">
      <figure className="m-0 flex min-w-0 flex-col gap-2">
        <figcaption className="text-meta font-semibold">
          {now ? `Now on ${screens === 1 ? '1 screen' : `${screens} screens`} · v${now.version}` : 'Now · never published'}
        </figcaption>
        {now ? (
          <Player stageKey={`${key}:now`} orgId={orgId} spot={now} label={`${after.name} as screens show it now`} after={false} />
        ) : (
          <div className="grid aspect-video place-items-center rounded-md border border-dashed text-sm text-muted-foreground">Not on any screen yet</div>
        )}
      </figure>
      <figure className="m-0 flex min-w-0 flex-col gap-2">
        <figcaption className="text-meta font-semibold">
          {after.version === stage.pinned
            ? `After approval · Draft ${after.version}`
            : `Draft ${after.version} · changed since it was asked for (Draft ${stage.pinned})`}
        </figcaption>
        <Player stageKey={`${key}:after`} orgId={orgId} spot={after} label={`${after.name} as approving would publish it`} after />
      </figure>
    </div>
  );
}
