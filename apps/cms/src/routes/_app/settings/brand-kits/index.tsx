/**
 * Settings, Brand kits (canvas board SettingsBrandKits): every kit with its look, its fonts,
 * where it is used and its contrast warnings, a new kit, a copy of one, the default, and the
 * curated fonts. Each opens in the kit editor.
 */
import { FONTS } from '@signforge/compiler';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { PaletteIcon, TriangleAlertIcon } from 'lucide-react';
import { CatalogueFonts, fontStack, KitTile } from '~/components/brand/kit-fields';
import { NameDialog } from '~/components/name-dialog';
import { EmptyState, PageHeader } from '~/components/page';
import { Button } from '~/components/ui/button';
import type { BrandKitView } from '~/lib/brand-kits';
import { useCanManage, useOrgId } from '~/lib/live';
import type { GroupView } from '~/lib/screen-types';
import { screensQuery } from '~/queries/screens';
import { brandKitsQuery } from '~/queries/spots';
import { kitActionRunning } from '~/state/brand-kits';
import { useAppStore } from '~/state/provider';

export const Route = createFileRoute('/_app/settings/brand-kits/')({
  loader: async ({ context: { queryClient }, parentMatchPromise }) => {
    const orgId = (await parentMatchPromise).loaderData?.orgId;
    if (!orgId) return;
    await Promise.all([queryClient.query(brandKitsQuery(orgId)), queryClient.query(screensQuery(orgId))]);
  },
  head: () => ({ meta: [{ title: 'Brand kits · SignForge' }] }),
  component: BrandKitsPage,
});

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** Where a kit is used, in a sentence. */
function usedText(k: BrandKitView, groups: GroupView[]) {
  const chosenBy = [
    ...groups.filter((g) => k.groupIds.includes(g.id)).map((g) => `group “${g.name}”`),
    ...(k.screenIds.length ? [plural(k.screenIds.length, 'screen')] : []),
  ];
  const reaches = `reaches ${plural(k.reach.length, 'screen')} at the next publish`;
  if (k.isDefault) return `The default: every screen without a kit of its own or its group's. It ${reaches}.`;
  if (chosenBy.length) return `Chosen by ${chosenBy.join(', ')}. It ${reaches}.`;
  return 'Not used yet: make it the default, or give it to a group or a screen.';
}

const fontsText = (k: BrandKitView) =>
  k.displayFont || k.bodyFont
    ? `${k.displayFont?.family ?? "The template's font"} over ${k.bodyFont?.family ?? "the template's font"}`
    : "The templates' own fonts";

function NewKitDialog({ orgId }: { orgId: string }) {
  const draft = useAppStore((s) => s.brandKits.newKit);
  const open = useAppStore((s) => s.openNewKit);
  const name = useAppStore((s) => s.nameNewKit);
  const create = useAppStore((s) => s.createKit);
  const busy = useAppStore(kitActionRunning);
  return (
    <NameDialog
      id="new-kit-name"
      thing="kit"
      title="New brand kit"
      description="It starts with the colours screens use without a kit. No screen wears it until it is used and published."
      draft={draft}
      busy={busy}
      onOpenChange={open}
      onName={name}
      onCreate={() => void create(orgId)}
    />
  );
}

function BrandKitsPage() {
  const orgId = useOrgId();
  const canManage = useCanManage();
  const { brandKits } = useSuspenseQuery(brandKitsQuery(orgId)).data;
  const { groups } = useSuspenseQuery(screensQuery(orgId)).data;
  const busy = useAppStore(kitActionRunning);
  const actionError = useAppStore((s) => s.brandKits.actionError);
  const edits = useAppStore((s) => s.brandKits.edits);
  const duplicate = useAppStore((s) => s.duplicateKit);
  const makeDefault = useAppStore((s) => s.makeDefaultKit);
  const kits = brandKits.toSorted((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));

  return (
    <div className="space-y-6">
      <CatalogueFonts />
      <PageHeader title="Brand kits" description={`${plural(kits.length, 'kit')} · a screen uses its own kit, else its group's, else the default.`}>
        {canManage && kits.length > 0 && <NewKitDialog orgId={orgId} />}
      </PageHeader>
      {kits.length ? (
        <ul className="flex flex-col gap-3">
          {kits.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-x-6 gap-y-4 rounded-xl border bg-card p-3.5">
              <KitTile name={k.name} colors={k.colors} displayFontId={k.displayFont?.id ?? null} className="sm:w-56" />
              <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <Link
                    to="/settings/brand-kits/$kitId"
                    params={{ kitId: k.id }}
                    className="text-lg font-semibold tracking-tight underline-offset-4 hover:underline"
                  >
                    {k.name}
                  </Link>
                  <span
                    className={
                      k.isDefault
                        ? 'rounded-xs bg-accent px-2 py-0.5 text-sm font-semibold text-accent-foreground'
                        : 'rounded-xs bg-muted px-2 py-0.5 text-sm font-semibold'
                    }
                  >
                    {k.isDefault ? 'Default' : plural(k.reach.length, 'screen')}
                  </span>
                  {edits[k.id]?.draft && (
                    <span className="rounded-xs bg-status-updating-muted px-2 py-0.5 text-sm font-semibold text-status-updating-foreground">
                      Unsaved changes
                    </span>
                  )}
                </span>
                <span>{fontsText(k)}</span>
                <span className="text-muted-foreground">{usedText(k, groups)}</span>
                {k.warnings.length > 0 && (
                  <span className="inline-flex items-start gap-1.5 text-sm">
                    <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-status-updating" aria-hidden />
                    <span>
                      {plural(k.warnings.length, 'contrast warning')}: {k.warnings.join('; ')}
                    </span>
                  </span>
                )}
                <span className="text-sm text-muted-foreground">Edited {new Date(k.updatedAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}</span>
                {/* A refused Duplicate or Make default, by the kit it was for. */}
                <p role="alert" className="text-sm font-medium text-destructive empty:hidden">
                  {actionError?.kitId === k.id ? actionError.text : null}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="outline">
                  <Link to="/settings/brand-kits/$kitId" params={{ kitId: k.id }} aria-label={`${canManage ? 'Edit' : 'Open'} ${k.name}`}>
                    {canManage ? 'Edit' : 'Open'}
                  </Link>
                </Button>
                {canManage && (
                  <Button variant="outline" aria-disabled={busy || undefined} onClick={() => void duplicate(orgId, k)} aria-label={`Duplicate ${k.name}`}>
                    Duplicate
                  </Button>
                )}
                {canManage && !k.isDefault && (
                  <Button
                    variant="outline"
                    aria-disabled={busy || undefined}
                    onClick={() => void makeDefault(orgId, k.id)}
                    aria-label={`Make default: ${k.name}`}
                  >
                    Make default
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon={PaletteIcon} title="No brand kits yet" action={canManage ? <NewKitDialog orgId={orgId} /> : undefined}>
          A kit holds your colours, fonts and logo. Every template draws with it, so one kit keeps every screen on brand.
        </EmptyState>
      )}

      <section aria-labelledby="curated-fonts" className="space-y-2.5 pt-1.5">
        <h2 id="curated-fonts" className="text-lg font-semibold">
          Curated fonts
        </h2>
        <p className="max-w-[70ch] text-muted-foreground">
          Kits pick from fonts tested on the Raspberry Pi at 1080p. Each family stays under 150 kB, so a screen is ready in half a second. More fonts, and your
          own, come later.
        </p>
        <ul className="flex flex-wrap gap-2">
          {FONTS.map((f) => (
            <li key={f.id} className="rounded-md border bg-card px-2.5 py-1.5 text-[15px]" style={{ fontFamily: fontStack(f.id) }}>
              {f.family}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
