/**
 * One brand kit (canvas board Idea 11, with BrandKit's fonts and logos): its colours, contrast,
 * fonts, corners and logo beside the org's own spots on the real player, re-theming as it is
 * edited, and where it is used (default, groups, screens) with the screens its edits reach at
 * the next publish. The draft and every action are in src/state/brand-kits.ts.
 *
 * It is a page of its own, outside the settings layout, as the board draws it: the previews need
 * the room beside the form. A player scrolled out of view is throttled by the browser and misses
 * its ready timeout, so on a narrow window they play once scrolled to.
 */
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { ChevronLeftIcon, TriangleAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { CatalogueFonts, ColourFields, FontField, LogoFields, ShapeField } from '~/components/brand/kit-fields';
import { KitPreviews } from '~/components/brand/kit-previews';
import { EditorFields } from '~/components/editor';
import { Alert, AlertDescription } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { draftColors, kitDraftOf, shownColors, type BrandKitView, type KitDraft } from '~/lib/brand-kits';
import { useCanManage, useOrgId } from '~/lib/live';
import type { GroupView, ScreenView } from '~/lib/screen-types';
import { versionsById, type SpotView } from '~/lib/spots';
import { byName } from '~/lib/targets';
import { screensQuery } from '~/queries/screens';
import { assetsQuery, brandKitsQuery, spotPreviewQuery, spotsQuery, templatesQuery } from '~/queries/spots';
import { useAppStore } from '~/state/provider';
import { kitActionRunning, previewKey } from '~/state/brand-kits';
import { shown } from '~/state/versioned-draft';

/** How many of the org's template spots the page plays: each is a player on the page. */
const PREVIEWS = 3;

/** The org's newest template spots, which the page previews. */
const previewSpots = (spots: SpotView[]) => spots.filter((s) => s.kind === 'template' && s.templateVersionId);

export const Route = createFileRoute('/_app/settings_/brand-kits/$kitId')({
  loader: async ({ context: { queryClient }, params, parentMatchPromise }) => {
    const orgId = (await parentMatchPromise).loaderData?.organization?.id;
    if (!orgId) return;
    const [{ brandKits }, { spots }] = await Promise.all([
      queryClient.query(brandKitsQuery(orgId)),
      queryClient.query(spotsQuery(orgId)),
      queryClient.query(screensQuery(orgId)),
      queryClient.query(templatesQuery(orgId)),
      queryClient.query(assetsQuery(orgId)),
    ]);
    if (!brandKits.some((k) => k.id === params.kitId)) throw notFound();
    await Promise.all(
      previewSpots(spots)
        .slice(0, PREVIEWS)
        .map((s) => queryClient.query(spotPreviewQuery(orgId, previewKey({ kitId: params.kitId, templateVersionId: s.templateVersionId ?? '' })))),
    );
  },
  head: () => ({ meta: [{ title: 'Brand kit · SignForge' }] }),
  component: KitEditor,
});

function Panel({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4 rounded-xl border bg-card p-4 sm:p-5">
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A few names, then how many more. */
function names(list: string[]) {
  if (list.length <= 3) return list.join(', ');
  return `${list.slice(0, 3).join(', ')} and ${list.length - 3} more`;
}

/** Default, groups and screens: who chose this kit, and the screens its edits reach. */
function KitUse({
  kit,
  kits,
  groups,
  screens,
  canManage,
}: {
  kit: BrandKitView;
  kits: BrandKitView[];
  groups: GroupView[];
  screens: ScreenView[];
  canManage: boolean;
}) {
  const orgId = useOrgId();
  const pending = useAppStore((s) => s.brandKits.pending);
  const busy = useAppStore(kitActionRunning);
  const assign = useAppStore((s) => s.assignKit);
  const makeDefault = useAppStore((s) => s.makeDefaultKit);
  const nameOf = (id: string) => screens.find((s) => s.id === id)?.name ?? id;
  const otherKit = (has: (k: BrandKitView) => boolean) => kits.find((k) => k.id !== kit.id && has(k))?.name;
  const choice = (key: string, label: string, saved: boolean, other: string | undefined, target: { groupId: string } | { screenId: string }) => {
    // While its change is on the way, the box shows where it is going.
    const chosen = pending === `assign:${key}` ? !saved : saved;
    return (
      <li key={key}>
        {/* Dimmed while an action runs, as a disabled box would be, so Space doing nothing is seen. */}
        <label className="flex min-h-10 items-center gap-3 text-sm has-[[aria-disabled=true]]:opacity-60">
          <input
            type="checkbox"
            checked={chosen}
            // Not disabled while an action runs: a disabled box loses keyboard focus. A change then is ignored.
            disabled={!canManage}
            aria-disabled={busy || undefined}
            onChange={(e) => void assign(orgId, kit, e.target.checked, target)}
            className="size-4 accent-primary"
          />
          <span className="min-w-0">
            <span className="font-medium">{label}</span>
            {!chosen && other && <span className="text-muted-foreground"> · uses {other}</span>}
          </span>
        </label>
      </li>
    );
  };

  return (
    <Panel id="kit-use" title="Where it is used">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm">
          {kit.isDefault ? (
            <>
              <strong className="font-semibold">The default kit.</strong> Every screen without a kit of its own or its group's wears it.
            </>
          ) : (
            'Not the default. Screens wear it when they or their group choose it.'
          )}
        </p>
        {canManage && !kit.isDefault && (
          <Button variant="outline" aria-disabled={busy || undefined} onClick={() => void makeDefault(orgId, kit.id)}>
            Make default
          </Button>
        )}
      </div>
      {kit.conflicts.length > 0 && (
        <Alert>
          <TriangleAlertIcon aria-hidden />
          <AlertDescription>
            {names(kit.conflicts.map((c) => nameOf(c.screenId)))} {kit.conflicts.length === 1 ? 'is' : 'are'} in groups that chose different kits, so{' '}
            {kit.conflicts.length === 1 ? 'it' : 'they'} cannot publish. Give the screen a kit of its own, or change a group.
          </AlertDescription>
        </Alert>
      )}
      <fieldset className="space-y-1">
        <legend className="mb-1 text-sm font-semibold">Groups</legend>
        {groups.length ? (
          <ul>
            {[...groups].sort(byName).map((g) =>
              choice(
                g.id,
                `${g.name} · ${g.screenIds.length} ${g.screenIds.length === 1 ? 'screen' : 'screens'}`,
                kit.groupIds.includes(g.id),
                otherKit((k) => k.groupIds.includes(g.id)),
                { groupId: g.id },
              ),
            )}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No groups yet. Make them on{' '}
            <Link to="/screens" className="text-primary underline underline-offset-4">
              Screens
            </Link>
            .
          </p>
        )}
      </fieldset>
      <fieldset className="space-y-1">
        <legend className="mb-1 text-sm font-semibold">Screens, on their own</legend>
        {screens.length ? (
          <ul>
            {[...screens].sort(byName).map((s) =>
              choice(
                s.id,
                s.name,
                kit.screenIds.includes(s.id),
                otherKit((k) => k.screenIds.includes(s.id)),
                { screenId: s.id },
              ),
            )}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No screens yet.</p>
        )}
        <p className="text-[13px] text-muted-foreground">A screen's own kit wins over its group's.</p>
      </fieldset>
    </Panel>
  );
}

function KitEditor() {
  const orgId = useOrgId();
  const { kitId } = Route.useParams();
  const canManage = useCanManage();
  const { brandKits } = useSuspenseQuery(brandKitsQuery(orgId)).data;
  const { spots } = useSuspenseQuery(spotsQuery(orgId)).data;
  const { screens, groups } = useSuspenseQuery(screensQuery(orgId)).data;
  const { templates } = useSuspenseQuery(templatesQuery(orgId)).data;
  const { assets } = useSuspenseQuery(assetsQuery(orgId)).data;

  const saved = useAppStore((s) => s.brandKits.drafts[kitId]);
  const unsaved = saved !== undefined && saved.status !== 'saved';
  const saving = saved?.pending ?? false;
  const savedAt = saved?.savedAt ?? null;
  const stale = saved?.stale ?? false;
  const saveError = stale ? 'This kit changed since you opened it.' : (saved?.error ?? null);
  const actionError = useAppStore((s) => (s.brandKits.actionError?.kitId === kitId ? s.brandKits.actionError.text : null));
  const busy = useAppStore(kitActionRunning);
  const logoFor = useAppStore((s) => s.brandKits.logoFor);
  const edit = useAppStore((s) => s.editKit);
  const fix = useAppStore((s) => s.fixKitPair);
  const discard = useAppStore((s) => s.discardKitDraft);
  const save = useAppStore((s) => s.saveKit);
  const reload = useAppStore((s) => s.reloadKit);
  const pickLogo = useAppStore((s) => s.pickLogo);
  const duplicate = useAppStore((s) => s.duplicateKit);

  const kit = brandKits.find((k) => k.id === kitId);
  if (!kit) return null;
  // A saved draft is shown while the kit is still at the version it saved.
  const draft = shown(saved, kit.version) ?? kitDraftOf(kit);
  const colors = shownColors(draft, kit.colors);
  const change = (c: (d: KitDraft) => KitDraft) => edit(orgId, kit.id, c);
  const set = (patch: Partial<KitDraft>) => change((d) => ({ ...d, ...patch }));
  const ready = unsaved && draftColors(draft) !== null && draft.name.trim() !== '' && !stale;
  const versions = versionsById(templates);
  const withTemplates = previewSpots(spots);
  const reach = kit.reach.map((id) => screens.find((s) => s.id === id)?.name ?? id);
  const statusWord = unsaved
    ? 'Unsaved changes'
    : savedAt
      ? `Saved ${new Date(savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      : 'Saved';

  return (
    <div className="space-y-5">
      <CatalogueFonts />
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <Link to="/settings/brand-kits" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ChevronLeftIcon className="size-4" aria-hidden /> Brand kits
          </Link>
          <h1 className="truncate text-2xl font-semibold tracking-tight sm:text-3xl">{draft.name || kit.name}</h1>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {kit.isDefault ? 'Default kit' : 'Brand kit'} · {statusWord}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <p role="status" className="max-w-[46ch] text-sm">
            {reach.length ? (
              <>
                Edits reach <strong className="font-semibold">{reach.length === 1 ? '1 screen' : `${reach.length} screens`}</strong> at the next publish:{' '}
                {names(reach)}.
              </>
            ) : (
              'No screen wears this kit yet. Edits reach screens once it is used and published.'
            )}
          </p>
          {canManage && (
            <EditorFields>
              <Button variant="outline" aria-disabled={busy || undefined} onClick={() => void duplicate(orgId, kit)}>
                Duplicate
              </Button>
              <Button variant="outline" disabled={!unsaved || saving} onClick={() => discard(kit.id)}>
                Discard changes
              </Button>
              <Button disabled={!ready} aria-disabled={busy || undefined} onClick={() => void save(kit.id)}>
                {saving ? 'Saving…' : 'Save kit'}
              </Button>
            </EditorFields>
          )}
        </div>
      </header>
      {(saveError ?? actionError) && (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {saveError ?? actionError}
            {stale && (
              <Button size="sm" variant="outline" onClick={() => void reload(orgId, kit.id)}>
                Reload
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[1_1_360px] flex-col gap-5">
          <EditorFields>
            <form aria-label="Kit" onSubmit={(e) => e.preventDefault()} className="flex flex-col gap-5">
              <Panel id="kit-colours" title="Colours">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="kit-name" className="font-medium">
                    Name
                  </label>
                  <Input
                    id="kit-name"
                    value={draft.name}
                    maxLength={100}
                    disabled={!canManage}
                    onChange={(e) => set({ name: e.target.value })}
                    aria-invalid={!draft.name.trim() || undefined}
                  />
                </div>
                <ColourFields
                  draft={draft}
                  shown={colors}
                  disabled={!canManage}
                  onChange={(name, value) => change((d) => ({ ...d, colors: { ...d.colors, [name]: value } }))}
                  onFix={(fg, bg) => fix(orgId, kit.id, fg, bg)}
                />
              </Panel>
              <Panel id="kit-type" title="Type and shape">
                <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">
                  <FontField use="display" value={draft.displayFontId} disabled={!canManage} onChange={(displayFontId) => set({ displayFontId })} />
                  <FontField use="body" value={draft.bodyFontId} disabled={!canManage} onChange={(bodyFontId) => set({ bodyFontId })} />
                </div>
                <ShapeField value={draft.shape} disabled={!canManage} onChange={(shape) => set({ shape })} />
                <LogoFields
                  draft={draft}
                  colors={colors}
                  assets={assets}
                  picking={logoFor}
                  disabled={!canManage}
                  onPick={pickLogo}
                  onChange={(which, assetId) =>
                    set(which === 'dark' ? { logoOnDarkAssetId: assetId, ...(assetId ? {} : { logoOnLightAssetId: null }) } : { logoOnLightAssetId: assetId })
                  }
                />
              </Panel>
            </form>
            <KitUse kit={kit} kits={brandKits} groups={groups} screens={screens} canManage={canManage} />
          </EditorFields>
        </div>
        {/* In view while the form scrolls: a player scrolled away is throttled and the edits would not show. */}
        <div className="flex min-w-0 flex-[999_1_480px] flex-col gap-5 lg:sticky lg:top-4">
          <KitPreviews
            orgId={orgId}
            kitId={kit.id}
            spots={withTemplates.slice(0, PREVIEWS)}
            total={withTemplates.length}
            whatOf={(s) => versions.get(s.templateVersionId ?? '')?.manifest.name ?? 'Template'}
          />
        </div>
      </div>
    </div>
  );
}
