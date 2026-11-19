/**
 * Spots: every spot's draft, most recently edited first, with what it is and whether screens have
 * it, and a dialog to make one (a template, an image or a web page). Each opens in the editor.
 */
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { EmptyState, PageHeader, ROW_LINK, RowText } from '~/components/page';
import { NewSpotDialog } from '~/components/spots/new-spot-dialog';
import { useCanManage, useOrgId } from '~/lib/live';
import { sectionFor } from '~/lib/sections';
import { publishWord, spotWhat, versionsById } from '~/lib/spots';
import { assetsQuery, spotsQuery, templatesQuery } from '~/queries/spots';

const section = sectionFor('/spots');

export const Route = createFileRoute('/_app/spots/')({
  loader: async ({ context: { queryClient }, parentMatchPromise }) => {
    const orgId = (await parentMatchPromise).loaderData?.organization?.id;
    if (!orgId) return;
    await Promise.all([queryClient.query(spotsQuery(orgId)), queryClient.query(templatesQuery(orgId)), queryClient.query(assetsQuery(orgId))]);
  },
  head: () => ({ meta: [{ title: `${section.label} · SignForge` }] }),
  component: SpotsPage,
});

function SpotsPage() {
  const orgId = useOrgId();
  const canManage = useCanManage();
  const { spots } = useSuspenseQuery(spotsQuery(orgId)).data;
  const { templates } = useSuspenseQuery(templatesQuery(orgId)).data;
  const versions = versionsById(templates);

  return (
    <div className="space-y-6">
      <PageHeader title={section.label} description={section.description}>
        {canManage && <NewSpotDialog orgId={orgId} templates={templates} />}
      </PageHeader>
      {spots.length ? (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card">
          {spots.map((s) => (
            <li key={s.id}>
              <Link to="/spots/$spotId" params={{ spotId: s.id }} className={ROW_LINK}>
                <RowText title={s.name}>
                  {spotWhat(s, versions)} · {publishWord(s)}
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
