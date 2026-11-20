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
import { createFileRoute, notFound } from '@tanstack/react-router';
import { AssetPicker } from '~/components/assets/asset-picker';
import { EditorFields, EditorHeader, EditorSection, PublishButton, SaveAlert, SaveDraftButton, saveWord } from '~/components/editor';
import { FieldForm } from '~/components/spots/field-form';
import { PlayerStage, stageSearch, type StageSearch } from '~/components/spots/player-stage';
import { SourceSection } from '~/components/spots/source-section';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { NativeSelect } from '~/components/ui/select';
import { useCanManage, useCanPublish, useOrgId } from '~/lib/live';
import { boundSource, typedFields } from '~/lib/live-data';
import { draftOf, publishWord, seconds, versionsById, type SpotDraft, type SpotView } from '~/lib/spots';
import { assetsQuery, brandKitsQuery, dataSourceQuery, dataSourcesQuery, spotPreviewQuery, spotQuery, templatesQuery } from '~/queries/spots';
import { useAppStore } from '~/state/provider';
import { spotShown } from '~/state/spot-editor';

export const Route = createFileRoute('/_app/spots/$spotId')({
  validateSearch: stageSearch,
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

function SpotEditor() {
  const orgId = useOrgId();
  const { spotId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const canManage = useCanManage();
  const canPublish = useCanPublish();
  const spot: SpotView | null = useSuspenseQuery(spotQuery(orgId, spotId)).data;
  const { templates } = useSuspenseQuery(templatesQuery(orgId)).data;
  const { assets } = useSuspenseQuery(assetsQuery(orgId)).data;
  const { brandKits } = useSuspenseQuery(brandKitsQuery(orgId)).data;
  const orientation = search.o ?? 'landscape';
  const templateVersionId = spot?.templateVersionId ?? undefined;
  const preview = useSuspenseQuery(spotPreviewQuery(orgId, { orientation, templateVersionId, brandKitId: search.kit })).data;

  const saved = useAppStore((s) => s.spotEditor.drafts[spotId]);
  const mine = saved?.orgId === orgId ? saved : undefined;
  // A saved draft is shown while the spot is still at the version it saved: what was typed stays, a trailing space included.
  const editing = useAppStore((s) => (spot ? spotShown(s.spotEditor, orgId, spot) : null));
  const status = mine?.status ?? 'saved';
  const savedAt = mine?.savedAt ?? null;
  const saveError = mine?.error ?? null;
  const stale = mine?.stale ?? false;
  const picking = useAppStore((s) => s.spotEditor.picking === 'assetId');
  const edit = useAppStore((s) => s.editSpot);
  const save = useAppStore((s) => s.saveSpotDraft);
  const reload = useAppStore((s) => s.reloadSpot);
  const pick = useAppStore((s) => s.pickImageFor);
  const publishing = useAppStore((s) => s.publishing.pending);
  const publish = useAppStore((s) => s.publishSpot);

  if (!spot) return null;
  const draft = editing ?? draftOf(spot);
  const version = versionsById(templates).get(templateVersionId ?? '');
  const change = (c: (d: SpotDraft) => SpotDraft) => edit(orgId, spot, c);
  const set = (patch: Partial<SpotDraft>) => change((d) => ({ ...d, ...patch }));
  const range = version?.manifest.duration;
  const durationBad = range ? draft.durationMs < range.minMs || draft.durationMs > range.maxMs : draft.durationMs < 1000;
  const image = assets.find((a) => a.id === draft.assetId);
  const what = spot.kind === 'template' ? (version?.manifest.name ?? 'Template') : spot.kind === 'url' ? 'Web page' : spot.kind === 'image' ? 'Image' : 'Video';
  const setSearch = (next: Partial<StageSearch>) => void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });

  return (
    <div className="flex min-h-[calc(100dvh-8rem)] flex-col overflow-hidden rounded-xl border">
      <EditorHeader
        back={{ to: '/spots', label: 'Spots' }}
        title={draft.name || spot.name}
        about={`${what} · ${saveWord(status, savedAt)} · ${publishWord(spot)}`}
      >
        {canManage && <SaveDraftButton status={status} stale={stale} onSave={() => void save(spotId)} />}
        {canPublish && <PublishButton pending={publishing} disabled={stale} onPublish={() => void publish(orgId, spotId)} />}
      </EditorHeader>
      <SaveAlert error={saveError} stale={stale} onReload={() => void reload(orgId, spotId)} />
      <div className="flex flex-1 flex-wrap items-stretch">
        <form
          aria-label="Spot fields"
          onSubmit={(e) => e.preventDefault()}
          className="flex max-w-full flex-[1_1_360px] flex-col gap-6 border-r bg-card px-4 pt-5 pb-8 sm:px-6"
        >
          <EditorFields disabled={!canManage}>
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
              <EditorSection title="Source">
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
              </EditorSection>
            )}
            {spot.kind === 'template' &&
              (version ? (
                <EditorSection title="Content">
                  <FieldForm fields={typedFields(version.manifest, draft.bindings)} draft={draft} assets={assets} onChange={change} />
                </EditorSection>
              ) : (
                <p className="text-sm text-muted-foreground">This spot's template is not available to this organization.</p>
              ))}
            {(spot.kind === 'image' || spot.kind === 'video') && (
              <EditorSection title={spot.kind === 'image' ? 'Image' : 'Video'}>
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
              </EditorSection>
            )}
            {spot.kind === 'url' && (
              <EditorSection title="Web page">
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
              </EditorSection>
            )}
            <EditorSection title="Timing">
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
            </EditorSection>
          </EditorFields>
        </form>
        <div className="flex min-w-0 flex-[999_1_560px] flex-col">
          <PlayerStage
            target={{ orgId, spotId, orientation, templateVersionId, brandKitId: search.kit }}
            kits={brandKits}
            kitId={preview.brandKitId}
            search={search}
            onSearch={setSearch}
            bound={Object.keys(draft.bindings).length > 0}
          />
        </div>
      </div>
    </div>
  );
}
