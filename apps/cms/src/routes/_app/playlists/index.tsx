/**
 * Playlists: every playlist's draft, most recently edited first, with how many spots it plays,
 * one loop's length, its transition and whether screens have it, and a dialog to make one. Each
 * opens in the editor.
 */
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { EmptyState, PageHeader, ROW_LINK, RowText } from '~/components/page';
import { NewPlaylistDialog } from '~/components/playlists/new-playlist-dialog';
import { useCanManage, useOrgId } from '~/lib/live';
import { clockLength, loopMs, playlistPublishWord, transitionWord } from '~/lib/playlists';
import { sectionFor } from '~/lib/sections';
import { playlistsQuery } from '~/queries/playlists';
import { spotsQuery } from '~/queries/spots';

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

  return (
    <div className="space-y-6">
      <PageHeader title={section.label} description={section.description}>
        {canManage && <NewPlaylistDialog orgId={orgId} />}
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
        <EmptyState icon={section.icon} title={section.empty.title}>
          {section.empty.body}
        </EmptyState>
      )}
    </div>
  );
}
