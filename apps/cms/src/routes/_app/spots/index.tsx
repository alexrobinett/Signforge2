/**
 * Spots: every spot's draft, most recently edited first, with what it is and whether screens have
 * it, and a dialog to make one (a template, an image or a web page). Each opens in the editor.
 */
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ChevronRightIcon } from 'lucide-react';
import { EmptyState, PageHeader } from '~/components/page';
import { NewSpotDialog } from '~/components/spots/new-spot-dialog';
import { useCanManage, useOrgId } from '~/lib/live';
import { sectionFor } from '~/lib/sections';
import { publishWord, versionsById, type SpotView, type TemplateVersionView } from '~/lib/spots';
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

const KIND_WORD = { image: 'Image', video: 'Video', url: 'Web page' } as const;

/** What the spot is, in a few words. */
const what = (s: SpotView, versions: Map<string, TemplateVersionView>) =>
  s.kind === 'template' ? (versions.get(s.templateVersionId ?? '')?.manifest.name ?? 'Template') : KIND_WORD[s.kind];

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
              <Link
                to="/spots/$spotId"
                params={{ spotId: s.id }}
                className="flex items-center gap-3 px-4 py-3 outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{s.name}</span>
                  <span className="block truncate text-sm text-muted-foreground">
                    {what(s, versions)} · {publishWord(s)}
                  </span>
                </span>
                <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden />
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
