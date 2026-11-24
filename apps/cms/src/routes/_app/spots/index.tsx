/**
 * Spots: every spot's draft, most recently edited first, with what it is and whether screens have
 * it, and a dialog to make one (a template, an image or a web page). Each opens in the editor. With
 * no spots yet, the page is the template gallery (#362): a template opens the dialog with it picked.
 */
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { EmptyState, PageHeader, ROW_LINK, RowText } from '~/components/page';
import { NewSpotDialog } from '~/components/spots/new-spot-dialog';
import { SpotThumb, TemplateThumb } from '~/components/spots/template-thumb';
import { useCanManage, useOrgId } from '~/lib/live';
import { sectionFor } from '~/lib/sections';
import { publishWord, spotWhat, type TemplateView, templatesByVersion, usableVersions, versionsById } from '~/lib/spots';
import { assetsQuery, spotsQuery, templatesQuery } from '~/queries/spots';
import { useAppStore } from '~/state/provider';

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
  const { assets } = useSuspenseQuery(assetsQuery(orgId)).data;
  const versions = versionsById(templates);
  const templateOf = templatesByVersion(templates);
  const assetsById = new Map(assets.map((a) => [a.id, a]));

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
                <SpotThumb spot={s} templateOf={templateOf} assets={assetsById} className="w-16 flex-none" />
                <RowText title={s.name}>
                  {spotWhat(s, versions)} · {publishWord(s)}
                </RowText>
              </Link>
            </li>
          ))}
        </ul>
      ) : canManage ? (
        <Gallery templates={templates} />
      ) : (
        <EmptyState icon={section.icon} title={section.empty.title}>
          {section.empty.body}
        </EmptyState>
      )}
    </div>
  );
}

/** No spots yet: the templates to start from, each opening New spot with it picked. */
function Gallery({ templates }: { templates: TemplateView[] }) {
  const open = useAppStore((s) => s.openNewSpot);
  const edit = useAppStore((s) => s.editNewSpot);
  return (
    <section aria-labelledby="gallery-title" className="space-y-4">
      <div className="space-y-1">
        <h2 id="gallery-title" className="text-lg font-semibold">
          {section.empty.title}
        </h2>
        <p className="text-sm text-muted-foreground">Start from a template. Each one opens as a draft you fill in; no screen shows it until you publish.</p>
      </div>
      <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {usableVersions(templates).map(({ template, version }) => (
          <li key={version.id}>
            <button
              type="button"
              onClick={() => {
                open(true);
                edit({ templateVersionId: version.id });
              }}
              className="flex w-full flex-col gap-2 rounded-xl border bg-card p-2 text-left text-sm font-medium outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <TemplateThumb template={template} />
              <span className="line-clamp-2 px-1 pb-1">{template.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
