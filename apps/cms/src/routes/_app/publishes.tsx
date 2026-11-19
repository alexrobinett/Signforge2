/**
 * Publishes (canvas board Ideas 5-6, rollout and undo): a publish's rollout, the latest unless the
 * URL names one (`?id=`), with why each waiting screen waits, and the publish history, where any
 * earlier publish can be rolled back to. Both stay current while the page is open
 * (src/queries/publishes.ts).
 */
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { EmptyState, PageHeader } from '~/components/page';
import { RolloutBar, RolloutLegend } from '~/components/publishes/rollout';
import { Button } from '~/components/ui/button';
import { useCanPublish, useNow, useOrgId } from '~/lib/live';
import { byWord, standing, versionName, type PublishView } from '~/lib/publishes';
import { sectionFor } from '~/lib/sections';
import { cn } from '~/lib/utils';
import { publishesQuery, publishQuery } from '~/queries/publishes';
import { useAppStore } from '~/state/provider';

export const Route = createFileRoute('/_app/publishes')({
  validateSearch: (s: Record<string, unknown>): { id?: string } => (typeof s.id === 'string' && s.id ? { id: s.id } : {}),
  loaderDeps: ({ search }) => ({ id: search.id }),
  loader: async ({ context: { queryClient }, deps, parentMatchPromise }) => {
    const orgId = (await parentMatchPromise).loaderData?.organization?.id;
    if (!orgId) return;
    await Promise.all([queryClient.query(publishQuery(orgId, deps.id ?? null)), queryClient.query(publishesQuery(orgId))]);
  },
  head: () => ({ meta: [{ title: 'Publishes · SignForge' }] }),
  component: PublishesPage,
});

const when = (ms: number) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** One line about a publish: when, who, and what kind. */
function about(p: PublishView, all: PublishView[]) {
  const restored = p.restoresId && all.find((x) => x.id === p.restoresId);
  const what = p.restoresId ? `Rolled back${restored ? ` to ${versionName(restored)}` : ''}` : 'Published';
  return `${what} ${when(p.createdAt)} by ${byWord(p)}`;
}

function PublishesPage() {
  const orgId = useOrgId();
  const search = Route.useSearch();
  const current = useSuspenseQuery(publishQuery(orgId, search.id ?? null));
  const { publish, screens } = current.data;
  const { publishes } = useSuspenseQuery(publishesQuery(orgId)).data;
  const canPublish = useCanPublish();
  const pending = useAppStore((s) => s.publishing.pending);
  const rollBack = useAppStore((s) => s.rollBackTo);
  const now = useNow(current.dataUpdatedAt);
  const section = sectionFor('/publishes');

  if (!publish) {
    return (
      <div className="space-y-8">
        <PageHeader title={section.label} description={section.description} />
        <EmptyState icon={section.icon} title={section.empty.title}>
          {section.empty.body}
        </EmptyState>
      </div>
    );
  }
  const v = versionName(publish);
  const latest = publishes[0];
  const restored = publish.restoresId ? publishes.find((p) => p.id === publish.restoresId) : undefined;
  const done = screens.filter((s) => s.outcome === 'playing').length;
  const waiting = screens.filter((s) => s.outcome !== 'playing' && s.outcome !== 'replaced').length;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={section.label} description={about(publish, publishes)} />
      <section aria-labelledby="rollout-title" className="flex flex-col gap-4 rounded-[14px] border bg-card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id="rollout-title" className="text-lg font-semibold">
            {restored ? `Rolling back to ${versionName(restored)} (${v})` : `Rollout of ${v}`}
          </h2>
          <p className="text-sm text-muted-foreground">
            <strong className="font-mono text-base font-semibold text-foreground">{done}</strong> of {screens.length} playing it
            {waiting === 0 && screens.length > 0 ? ' · complete' : ''}
          </p>
        </div>
        {screens.length ? (
          <>
            <RolloutBar publish={publish} screens={screens} now={now} />
            <RolloutLegend publish={publish} screens={screens} now={now} reasons />
          </>
        ) : (
          <p className="text-muted-foreground">It switched no screen: what it published plays nowhere yet.</p>
        )}
      </section>

      <section aria-labelledby="history-title" className="flex flex-col gap-3">
        <h2 id="history-title" className="text-lg font-semibold">
          Publish history
        </h2>
        <ol className="divide-y rounded-[14px] border bg-card">
          {publishes.map((p) => {
            // Of the screens it switched, the share that played it: all of them once it finished.
            const share = p.finishedAt ? 100 : p.screens ? Math.round((p.playing / p.screens) * 100) : 0;
            return (
              <li key={p.id} className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3', p.id === publish.id && 'bg-accent/60')}>
                <Link
                  to="/publishes"
                  search={p.id === latest?.id ? {} : { id: p.id }}
                  aria-current={p.id === publish.id ? 'page' : undefined}
                  className="w-14 font-mono font-semibold underline-offset-4 hover:underline"
                >
                  {versionName(p)}
                </Link>
                <span className="min-w-0 flex-[1_1_14rem] text-sm text-muted-foreground">{about(p, publishes)}</span>
                <span aria-hidden className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                  <span className="block h-full bg-chart-1" style={{ width: `${share}%` }} />
                </span>
                <span className="w-24 font-mono text-sm">{standing(p)}</span>
                {canPublish && p.id !== latest?.id && (
                  <Button variant="outline" size="sm" disabled={pending} onClick={() => void rollBack(orgId, p)}>
                    Roll back to {versionName(p)}
                  </Button>
                )}
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
