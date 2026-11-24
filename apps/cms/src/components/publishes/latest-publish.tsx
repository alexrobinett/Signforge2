/**
 * The latest publish and how its rollout stands (board Screens A), linking to its reasons: on the
 * Screens page and Overview. Nothing until there is a publish; one that reached no screen says so.
 * Its time is in the browser's zone, so it is drawn once the page has hydrated: the server's zone
 * may differ, and the two renders must match.
 */
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { RolloutBar, RolloutLegend } from '~/components/publishes/rollout';
import { useHydrated } from '~/lib/hydrated';
import { byWord, publishTitle } from '~/lib/publishes';
import { publishQuery } from '~/queries/publishes';

const app = getRouteApi('/_app');

export function LatestPublish({ orgId, now }: { orgId: string; now: number }) {
  const { data } = useQuery(publishQuery(orgId, null));
  const me = app.useLoaderData().user.id;
  const hydrated = useHydrated();
  const publish = data?.publish;
  if (!publish) return null;
  const at = hydrated ? ` ${new Date(publish.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
  return (
    <section aria-label="Latest publish" className="flex flex-col gap-3.5 rounded-xl border bg-card px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <p className="text-base">
          <strong className="font-semibold">{publishTitle(publish)}</strong>{' '}
          <span className="text-muted-foreground">
            · {publish.restoresId ? 'rolled back' : 'published'}
            {at} by {byWord(publish, me)}
          </span>
        </p>
        <Link to="/publishes" className="flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline sm:min-h-0 sm:py-1.5">
          View rollout
        </Link>
      </div>
      {data.screens.length ? (
        <>
          <RolloutBar publish={publish} screens={data.screens} now={now} />
          <RolloutLegend publish={publish} screens={data.screens} now={now} />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">It changed what no screen plays.</p>
      )}
    </section>
  );
}
