/**
 * Spots: every spot's draft, most recently edited first, with what it is and whether screens have
 * it, and a dialog to make one (a template, an image or a web page). Each opens in the editor. With
 * no spots yet, the empty state's New spot (#369) and under it the template gallery (#362): a
 * template opens the dialog with it picked.
 */
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { EmptyState, PageHeader, ROW_LINK, RowText } from '~/components/page';
import { NewSpotDialog } from '~/components/spots/new-spot-dialog';
import { SpotThumb, TemplateThumb } from '~/components/spots/template-thumb';
import { useCanManage, useOrgId } from '~/lib/live';
import { ASK_AN_EDITOR, sectionFor } from '~/lib/sections';
import { publishWord, spotWhat, type TemplateView, usableVersions, versionsById } from '~/lib/spots';
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
  const versions = versionsById(templates);

  return (
    <div className="space-y-6">
      {/* With no spots, New spot is the empty state's own action, the one on the page (#369). */}
      <PageHeader title={section.label} description={section.description}>
        {canManage && spots.length > 0 && <NewSpotDialog orgId={orgId} templates={templates} />}
      </PageHeader>
      {spots.length ? (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card">
          {spots.map((s) => (
            <li key={s.id}>
              <Link to="/spots/$spotId" params={{ spotId: s.id }} className={ROW_LINK}>
                <SpotThumb orgId={orgId} spot={s} className="w-16 flex-none" />
                <RowText title={s.name}>
                  {spotWhat(s, versions)} · {publishWord(s)}
                </RowText>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <>
          <EmptyState
            icon={section.icon}
            title={section.empty.title}
            action={canManage ? <NewSpotDialog orgId={orgId} templates={templates} /> : <p className="text-sm text-muted-foreground">{ASK_AN_EDITOR}</p>}
          >
            {section.empty.body}
          </EmptyState>
          {canManage && <Gallery templates={templates} />}
        </>
      )}
    </div>
  );
}

/** No spots yet: the templates to start from, each opening New spot with it picked. Outlined tiles: New spot above is the page's filled button. */
function Gallery({ templates }: { templates: TemplateView[] }) {
  const start = useAppStore((s) => s.startSpotFrom);
  return (
    <section aria-labelledby="gallery-title" className="space-y-4">
      <div className="space-y-1">
        <h2 id="gallery-title" className="text-lg font-semibold">
          Templates
        </h2>
        <p className="text-sm text-muted-foreground">Each opens New spot with it picked. A spot is a draft until you publish it.</p>
      </div>
      <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {usableVersions(templates).map(({ version }) => (
          <li key={version.id}>
            <button
              type="button"
              onClick={() => start(version.id)}
              className="flex w-full flex-col gap-2 rounded-xl border bg-card p-2 text-left text-sm font-medium outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <TemplateThumb version={version} />
              <span className="line-clamp-2 px-1 pb-1">{version.manifest.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
