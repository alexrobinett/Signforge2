/**
 * The spot editor (canvas board Spot editor A): the form beside the live stage. The form is made
 * from the template's fields (or the image, video or web page settings); every change goes to the
 * stage at once and to the spot's draft a moment later (src/state/spot-editor.ts). A template
 * with live fields gets a Source section instead of those fields (src/components/spots/source-section.tsx).
 * The stage's orientation, scale, brand kit and data are in the URL:
 * `?o=portrait&scale=actual&kit=<id>&data=fallback`.
 */
import { safeUrl, sessionBlobPath } from '@signforge/contract';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { ChevronLeftIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { AssetPicker } from '~/components/assets/asset-picker';
import { FieldForm } from '~/components/spots/field-form';
import { PlayerStage } from '~/components/spots/player-stage';
import { SourceSection } from '~/components/spots/source-section';
import { Alert, AlertDescription } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { NativeSelect } from '~/components/ui/select';
import { useCanManage, useOrgId } from '~/lib/live';
import { boundSource, typedFields } from '~/lib/live-data';
import { draftOf, publishWord, seconds, versionsById, type SpotDraft, type SpotView } from '~/lib/spots';
import { assetsQuery, brandKitsQuery, dataSourceQuery, dataSourcesQuery, spotPreviewQuery, spotQuery, templatesQuery } from '~/queries/spots';
import { useAppStore } from '~/state/provider';

interface Search {
  o?: 'portrait';
  scale?: 'actual';
  kit?: string;
  /** The stage plays the fallback values instead of the bound sources' data. */
  data?: 'fallback';
}

export const Route = createFileRoute('/_app/spots/$spotId')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(s.o === 'portrait' ? { o: 'portrait' as const } : {}),
    ...(s.scale === 'actual' ? { scale: 'actual' as const } : {}),
    ...(typeof s.kit === 'string' && s.kit ? { kit: s.kit } : {}),
    ...(s.data === 'fallback' ? { data: 'fallback' as const } : {}),
  }),
  loaderDeps: ({ search }) => ({ o: search.o, kit: search.kit }),
  loader: async ({ context: { queryClient }, params, deps, parentMatchPromise }) => {
    const orgId = (await parentMatchPromise).loaderData?.organization?.id;
    if (!orgId) return;
    const [spot, { templates }] = await Promise.all([
      queryClient.query(spotQuery(orgId, params.spotId)),
      queryClient.query(templatesQuery(orgId)),
      queryClient.query(assetsQuery(orgId)),
      queryClient.query(brandKitsQuery(orgId)),
    ]);
    if (!spot) throw notFound();
    const live = versionsById(templates).get(spot.templateVersionId ?? '')?.manifest.live;
    const bound = live && boundSource(live, spot.bindings ?? {});
    await Promise.all([
      queryClient.query(
        spotPreviewQuery(orgId, { orientation: deps.o ?? 'landscape', templateVersionId: spot.templateVersionId ?? undefined, brandKitId: deps.kit }),
      ),
      live && queryClient.query(dataSourcesQuery(orgId)),
      bound && queryClient.query(dataSourceQuery(orgId, bound)),
    ]);
  },
  head: () => ({ meta: [{ title: 'Spot · SignForge' }] }),
  component: SpotEditor,
});

/** How the save is going, in the header's words. */
function saveWord(status: string, savedAt: number | null) {
  if (status === 'saving') return 'Saving…';
  if (status === 'invalid') return 'Not saved: fix the marked field';
  if (status === 'unsaved') return 'Unsaved changes';
  return savedAt ? `Saved ${new Date(savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'No changes yet';
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-3.5">
      <legend className="mb-3 text-xs font-semibold tracking-[0.06em] text-muted-foreground uppercase">{title}</legend>
      {children}
    </fieldset>
  );
}

function SpotEditor() {
  const orgId = useOrgId();
  const { spotId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const canManage = useCanManage();
  const spot: SpotView | null = useSuspenseQuery(spotQuery(orgId, spotId)).data;
  const { templates } = useSuspenseQuery(templatesQuery(orgId)).data;
  const { assets } = useSuspenseQuery(assetsQuery(orgId)).data;
  const { brandKits } = useSuspenseQuery(brandKitsQuery(orgId)).data;
  const orientation = search.o ?? 'landscape';
  const templateVersionId = spot?.templateVersionId ?? undefined;
  const preview = useSuspenseQuery(spotPreviewQuery(orgId, { orientation, templateVersionId, brandKitId: search.kit })).data;

  const editing = useAppStore((s) => (s.spotEditor.spotId === spotId ? s.spotEditor.draft : null));
  const status = useAppStore((s) => (s.spotEditor.spotId === spotId ? s.spotEditor.status : 'saved'));
  const savedAt = useAppStore((s) => (s.spotEditor.spotId === spotId ? s.spotEditor.savedAt : null));
  const saveError = useAppStore((s) => (s.spotEditor.spotId === spotId ? s.spotEditor.saveError : null));
  const stale = useAppStore((s) => s.spotEditor.spotId === spotId && s.spotEditor.stale);
  const picking = useAppStore((s) => s.spotEditor.picking === 'assetId');
  const edit = useAppStore((s) => s.editSpot);
  const save = useAppStore((s) => s.saveSpotDraft);
  const reload = useAppStore((s) => s.reloadSpot);
  const pick = useAppStore((s) => s.pickImageFor);

  if (!spot) return null;
  const draft = editing ?? draftOf(spot);
  const version = versionsById(templates).get(templateVersionId ?? '');
  const change = (c: (d: SpotDraft) => SpotDraft) => edit(spot, c);
  const set = (patch: Partial<SpotDraft>) => change((d) => ({ ...d, ...patch }));
  const range = version?.manifest.duration;
  const durationBad = range ? draft.durationMs < range.minMs || draft.durationMs > range.maxMs : draft.durationMs < 1000;
  const image = assets.find((a) => a.id === draft.assetId);
  const what = spot.kind === 'template' ? (version?.manifest.name ?? 'Template') : spot.kind === 'url' ? 'Web page' : spot.kind === 'image' ? 'Image' : 'Video';
  const setSearch = (next: Partial<Search>) => void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });

  return (
    <div className="flex min-h-[calc(100dvh-8rem)] flex-col overflow-hidden rounded-xl border">
      <header className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b bg-card px-4 py-2.5 sm:px-6">
        <Link to="/spots" className="flex items-center gap-1.5 py-2.5 text-muted-foreground hover:text-foreground">
          <ChevronLeftIcon className="size-4" aria-hidden />
          Spots
        </Link>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 className="truncate text-[17px] font-semibold">{draft.name || spot.name}</h1>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {what} · {saveWord(status, savedAt)} · {publishWord(spot)}
          </p>
        </div>
        {canManage && (
          <div className="ml-auto flex gap-2">
            <Button variant="outline" disabled={status === 'saved' || status === 'saving' || stale} onClick={() => void save()}>
              Save draft
            </Button>
          </div>
        )}
      </header>
      {(stale || saveError) && (
        <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {saveError}
            {stale && (
              <Button size="sm" variant="outline" onClick={() => void reload()}>
                Reload
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      <div className="flex flex-1 flex-wrap items-stretch">
        <form
          aria-label="Spot fields"
          onSubmit={(e) => e.preventDefault()}
          className="flex max-w-full flex-[1_1_360px] flex-col gap-6 border-r bg-card px-4 pt-5 pb-8 sm:px-6"
        >
          <fieldset disabled={!canManage} className="contents">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="spot-name" className="font-medium">
                Name
              </label>
              <Input
                id="spot-name"
                value={draft.name}
                maxLength={100}
                onChange={(e) => set({ name: e.target.value })}
                aria-invalid={!draft.name.trim() || undefined}
              />
            </div>
            {spot.kind === 'template' && version?.manifest.live && (
              <Section title="Source">
                <SourceSection
                  orgId={orgId}
                  spot={spot}
                  manifest={version.manifest}
                  live={version.manifest.live}
                  draft={draft}
                  assets={assets}
                  canManage={canManage}
                  onChange={change}
                />
              </Section>
            )}
            {spot.kind === 'template' &&
              (version ? (
                <Section title="Content">
                  <FieldForm fields={typedFields(version.manifest)} draft={draft} assets={assets} onChange={change} />
                </Section>
              ) : (
                <p className="text-sm text-muted-foreground">This spot's template is not available to this organization.</p>
              ))}
            {(spot.kind === 'image' || spot.kind === 'video') && (
              <Section title={spot.kind === 'image' ? 'Image' : 'Video'}>
                <div className="flex items-center gap-3">
                  <div className="grid h-14 w-24 shrink-0 place-items-center overflow-hidden rounded-md bg-[#0e0f12]">
                    {image && <img src={sessionBlobPath(image.sha256)} alt="" className="size-full object-cover" />}
                  </div>
                  <span className="min-w-0 flex-1 truncate text-sm">{image?.name ?? 'Not in the library'}</span>
                  {spot.kind === 'image' && (
                    <Button type="button" variant="outline" onClick={() => pick('assetId')}>
                      Replace
                    </Button>
                  )}
                </div>
                <AssetPicker assets={assets} open={picking} onOpenChange={(o) => pick(o ? 'assetId' : null)} onPick={(a) => set({ assetId: a.id })} />
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="spot-fit" className="font-medium">
                    Fit
                  </label>
                  <NativeSelect id="spot-fit" value={draft.fit} onChange={(e) => set({ fit: e.target.value === 'contain' ? 'contain' : 'cover' })}>
                    <option value="cover">Fill the screen (crops the edges)</option>
                    <option value="contain">Show it whole (bars at the sides)</option>
                  </NativeSelect>
                </div>
              </Section>
            )}
            {spot.kind === 'url' && (
              <Section title="Web page">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="spot-url" className="font-medium">
                    Address
                  </label>
                  <Input
                    id="spot-url"
                    type="url"
                    inputMode="url"
                    value={draft.url}
                    onChange={(e) => set({ url: e.target.value })}
                    aria-invalid={!safeUrl(draft.url) || undefined}
                    aria-describedby="spot-url-help"
                  />
                  <p id="spot-url-help" className={safeUrl(draft.url) ? 'text-sm text-muted-foreground' : 'text-sm font-medium text-destructive'}>
                    {safeUrl(draft.url) ? 'An https page, shown full screen.' : 'The address must start with https://.'}
                  </p>
                </div>
              </Section>
            )}
            <Section title="Timing">
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="spot-duration" className="font-medium">
                  Duration
                </label>
                <span className="flex items-center gap-2">
                  <Input
                    id="spot-duration"
                    type="number"
                    inputMode="decimal"
                    min={range ? range.minMs / 1000 : 1}
                    max={range ? range.maxMs / 1000 : undefined}
                    step="any"
                    value={seconds(draft.durationMs)}
                    onChange={(e) => set({ durationMs: Number.isNaN(e.target.valueAsNumber) ? 0 : Math.round(e.target.valueAsNumber * 1000) })}
                    className="w-24 text-center font-mono"
                    aria-invalid={durationBad || undefined}
                    aria-describedby="spot-duration-help"
                  />
                  <span className="text-sm text-muted-foreground">s</span>
                </span>
              </div>
              <p id="spot-duration-help" className={durationBad ? 'text-sm font-medium text-destructive' : 'text-sm text-muted-foreground'}>
                {range
                  ? `Seconds on screen each time the playlist reaches it: ${seconds(range.minMs)} to ${seconds(range.maxMs)}.`
                  : 'Seconds on screen each time the playlist reaches it.'}
              </p>
            </Section>
          </fieldset>
        </form>
        <div className="flex min-w-0 flex-[999_1_560px] flex-col">
          <PlayerStage
            target={{ orgId, spotId, orientation, templateVersionId, brandKitId: search.kit, live: search.data !== 'fallback' }}
            scale={search.scale ?? 'fit'}
            kits={brandKits}
            kitId={preview.brandKitId}
            onOrientation={(o) => setSearch({ o: o === 'portrait' ? 'portrait' : undefined })}
            onScale={(s) => setSearch({ scale: s === 'actual' ? 'actual' : undefined })}
            onKit={(kit) => setSearch({ kit })}
            onLive={Object.keys(draft.bindings).length ? (on) => setSearch({ data: on ? undefined : 'fallback' }) : undefined}
          />
        </div>
      </div>
    </div>
  );
}
