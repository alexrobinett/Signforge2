/**
 * Approvals (#115, canvas board AgentApprovals): the publish requests waiting for someone who may
 * publish, each with who asked and why, what it changes and on which screens, and its spots on the
 * real player as screens have them and as approving publishes them. Approve and publish, Decline and
 * Open draft; one who may not approve sees the requests without the first two. A request's alert
 * links here, at the request (`#<id>`).
 */
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router';
import { BotIcon, UserIcon } from 'lucide-react';
import { ApproveDialog } from '~/components/approvals/approve-dialog';
import { StagePair } from '~/components/approvals/stage-pair';
import { EmptyState, PageHeader } from '~/components/page';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { type ApprovalItem, askerKind, askerName, changeWords, reachWords, requestTitle } from '~/lib/approvals';
import { useCanApprove, useOrgId } from '~/lib/live';
import { sectionFor } from '~/lib/sections';
import { cn } from '~/lib/utils';
import { approvalsQuery } from '~/queries/approvals';
import { useAppStore } from '~/state/provider';

export const Route = createFileRoute('/_app/approvals')({
  loader: async ({ context: { queryClient }, parentMatchPromise }) => {
    const orgId = (await parentMatchPromise).loaderData?.organization?.id;
    if (orgId) await queryClient.query(approvalsQuery(orgId));
  },
  head: () => ({ meta: [{ title: 'Approvals · SignForge' }] }),
  component: ApprovalsPage,
});

const app = getRouteApi('/_app');

const when = (ms: number) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function ApprovalsPage() {
  const orgId = useOrgId();
  const { items } = useSuspenseQuery(approvalsQuery(orgId)).data;
  const section = sectionFor('/approvals');
  // The confirmation shows the request as it was when Approve was pressed, whatever the queue reads meanwhile.
  const open = useAppStore((s) => s.approvals.confirming);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Waiting for approval" description={section.description} />
      {items.length ? (
        items.map((item) => <RequestCard key={item.check.request.id} item={item} orgId={orgId} />)
      ) : (
        <EmptyState icon={section.icon} title={section.empty.title}>
          {section.empty.body}
        </EmptyState>
      )}
      {open && <ApproveDialog item={open} orgId={orgId} />}
    </div>
  );
}

/** Where its first draft is edited. */
function OpenDraft({ item }: { item: ApprovalItem }) {
  const [first] = item.check.request.drafts;
  const className = 'h-11';
  if (first?.kind === 'spot')
    return (
      <Button asChild variant="outline" className={className}>
        <Link to="/spots/$spotId" params={{ spotId: first.id }}>
          Open draft
        </Link>
      </Button>
    );
  if (first?.kind === 'playlist')
    return (
      <Button asChild variant="outline" className={className}>
        <Link to="/playlists/$playlistId" params={{ playlistId: first.id }}>
          Open draft
        </Link>
      </Button>
    );
  return (
    <Button asChild variant="outline" className={className}>
      <Link to="/schedule">Open draft</Link>
    </Button>
  );
}

function RequestCard({ item, orgId }: { item: ApprovalItem; orgId: string }) {
  const { check, stages } = item;
  const { request, refused, held } = check;
  const canApprove = useCanApprove();
  const me = app.useLoaderData().user.name;
  const deciding = useAppStore((s) => s.approvals.deciding);
  const askApprove = useAppStore((s) => s.askApprove);
  const decline = useAppStore((s) => s.declineRequest);
  const busy = deciding !== null;
  const titleId = `${request.id}-title`;
  const Icon = request.requestedBy.kind === 'agent' ? BotIcon : UserIcon;
  const { connectedBy } = request.requestedBy;
  return (
    <article
      id={request.id}
      aria-labelledby={titleId}
      className={cn('flex scroll-mt-6 flex-col gap-4 rounded-xl border bg-card p-5', deciding === request.id && 'opacity-70')}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span aria-hidden className="grid size-9 flex-none place-items-center rounded-lg bg-foreground text-background">
            <Icon className="size-4" />
          </span>
          <div className="flex flex-col gap-0.5">
            <h2 id={titleId} className="text-lg font-semibold">
              {requestTitle(check)}
            </h2>
            <span className="text-sm text-muted-foreground">
              <bdi className="[overflow-wrap:anywhere]">{askerName(request)}</bdi>, {askerKind(request)} · asked {when(request.createdAt)}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {canApprove && (
            // Not disabled while a decision runs: focus would leave it (README, React rules).
            <Button
              variant="outline"
              className={cn('h-11', busy && 'opacity-60')}
              aria-disabled={busy}
              onClick={() => !busy && void decline(orgId, request.id)}
            >
              Decline
            </Button>
          )}
          <OpenDraft item={item} />
          {canApprove && (
            <Button
              className={cn('h-11', (busy || refused) && 'opacity-60')}
              aria-disabled={busy || refused !== null}
              aria-describedby={refused ? `${request.id}-refused` : undefined}
              onClick={() => !busy && !refused && askApprove(item)}
            >
              Approve and publish
            </Button>
          )}
        </div>
      </div>
      <p className="m-0 rounded-lg bg-muted px-3 py-2.5 leading-normal">
        <strong className="font-semibold">Asked for:</strong> “<bdi className="[overflow-wrap:anywhere]">{request.reason}</bdi>”
        {connectedBy && (
          <>
            {' · '}
            <bdi className="[overflow-wrap:anywhere]">{connectedBy}</bdi>
          </>
        )}
      </p>
      {refused && (
        <Alert id={`${request.id}-refused`}>
          <AlertTitle>Approving it now would be refused</AlertTitle>
          <AlertDescription>
            {refused.message}
            {held.length > 0 && `: ${held.flatMap((h) => h.problems).join('; ')}`}. Decline it, or ask for it again.
          </AlertDescription>
        </Alert>
      )}
      {stages.map((stage) => (
        <StagePair
          key={stage.after.id}
          requestId={request.id}
          orgId={orgId}
          stage={stage}
          screens={check.liveOn.find((l) => l.spotId === stage.after.id)?.screens ?? 0}
        />
      ))}
      <p className="m-0 text-meta text-muted-foreground">
        {[
          changeWords(check),
          reachWords(check),
          canApprove ? `approving publishes as you${me ? `, ${me}` : ''}` : 'only someone who may publish can approve it',
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
    </article>
  );
}
