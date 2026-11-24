/**
 * Playlists: every playlist's draft, most recently edited first, with how many spots it plays,
 * one loop's length, its transition and whether screens have it, and a dialog to make one. Each
 * opens in the editor.
 */
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import { EmptyState, PageHeader, ROW_LINK, RowText } from '~/components/page';
import { NewPlaylistDialog } from '~/components/playlists/new-playlist-dialog';
import { Button } from '~/components/ui/button';
import { useCanManage, useOrgId } from '~/lib/live';
import { clockLength, loopMs, playlistPublishWord, transitionWord } from '~/lib/playlists';
import { ASK_AN_EDITOR, sectionFor } from '~/lib/sections';
import { playlistsQuery } from '~/queries/playlists';
import { spotsQuery } from '~/queries/spots';
import { useAppStore } from '~/state/provider';

const section = sectionFor('/playlists');

export const Route = createFileRoute('/_app/playlists/')({
  loader: async ({ context: { queryClient }, parentMatchPromise }) => {
    const orgId = (await parentMatchPromise).loaderData?.organization?.id;
    if (!orgId) return;
    await Promise.all([queryClient.query(playlistsQuery(orgId)), queryClient.query(spotsQuery(orgId))]);
  },
  head: () => ({ meta: [{ title: `${section.label} · SignForge` }] }),
  component: PlaylistsPage,
});

function PlaylistsPage() {
  const orgId = useOrgId();
  const canManage = useCanManage();
  const { playlists } = useSuspenseQuery(playlistsQuery(orgId)).data;
  const { spots } = useSuspenseQuery(spotsQuery(orgId)).data;
  const byId = new Map(spots.map((s) => [s.id, s]));
  const newSpot = useAppStore((s) => s.openNewSpot);

  return (
    <div className="space-y-6">
      {/* With no playlists, the empty state's action is the one on the page (#369): New playlist, or New spot first when there is none to put in one. */}
      <PageHeader title={section.label} description={section.description}>
        {canManage && playlists.length > 0 && <NewPlaylistDialog orgId={orgId} />}
      </PageHeader>
      {playlists.length ? (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card">
          {playlists.map((p) => (
            <li key={p.id}>
              <Link to="/playlists/$playlistId" params={{ playlistId: p.id }} className={ROW_LINK}>
                <RowText title={p.name}>
                  {p.spotIds.length === 1 ? '1 spot' : `${p.spotIds.length} spots`} · {clockLength(loopMs(p.spotIds, byId))} loop ·{' '}
                  {transitionWord(p.transition)} · {playlistPublishWord(p)}
                </RowText>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={section.icon}
          title={spots.length ? section.empty.title : 'Make a spot first, then a playlist'}
          action={
            !canManage ? (
              <p className="text-sm text-muted-foreground">{ASK_AN_EDITOR}</p>
            ) : spots.length ? (
              <NewPlaylistDialog orgId={orgId} />
            ) : (
              <Button asChild>
                <Link to="/spots" onClick={() => newSpot(true)}>
                  <PlusIcon aria-hidden />
                  New spot
                </Link>
              </Button>
            )
          }
        >
          {spots.length ? section.empty.body : 'A playlist plays spots in order, in a loop. Make a spot from a template, then put it in a playlist here.'}
        </EmptyState>
      )}
    </div>
  );
}
