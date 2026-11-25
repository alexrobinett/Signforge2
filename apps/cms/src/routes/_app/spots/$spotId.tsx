/**
 * The spot editor (canvas board Spot editor A): the form beside the live stage. The form is made
 * from the template's fields (or the image, video or web page settings); every change goes to the
 * stage at once and to the spot's draft a moment later (src/state/spot-editor.ts). A template
 * with live fields gets a Source section instead of those fields (src/components/spots/source-section.tsx).
 * A spot the agent just filled (#263) opens with its marks and a banner (src/components/spots/fill-marks.tsx).
 * Fill from a flyer updates a template spot (#264): its review takes the form's place, with the stage
 * first on a phone, until it is kept or let go (src/components/spots/fill-review.tsx).
 * Delete (#242) asks first; a spot a playlist plays is refused, and the dialog links those playlists.
 * The stage's orientation, scale, brand kit and data are in the URL:
 * `?o=portrait&scale=actual&kit=<id>&data=fallback`.
 */
import { useDeferredValue } from 'react';
import { startData } from '@signforge/compiler/draft';
import { liveSources, safeUrl, sessionBlobPath } from '@signforge/contract';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { SparklesIcon } from 'lucide-react';
import { AssetPicker } from '~/components/assets/asset-picker';
import { EditorDeleteQuestion, EditorFields, EditorMoreMenu, EditorHeader, EditorSection, PublishButton, SaveAlert, saveWord } from '~/components/editor';
import { ProposalPanel } from '~/components/proposal';
import { FieldForm } from '~/components/spots/field-form';
import { FillBanner, UpdateBanner } from '~/components/spots/fill-marks';
import { FillReview, FillSpotDialog } from '~/components/spots/fill-review';
import { EDITOR, EDITOR_FORM, EDITOR_ROW, PlayerStage, STAGE_COLUMN, stageSearch, type StageSearch } from '~/components/spots/player-stage';
import { SourceSection } from '~/components/spots/source-section';
import { AlertDialogCancel, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '~/components/ui/alert-dialog';
import { Button } from '~/components/ui/button';
import { templateThumbnail } from '~/lib/template-thumbnail';
import { cn } from '~/lib/utils';
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
  // Entering reads the stage's preview in the loader, so the skeleton shows while it comes (#376); the
  // orientation or kit changed on the page is read by its query, deferred, keeping the editor and its focus.
  loader: async ({ context: { queryClient }, params, location, parentMatchPromise }) => {
    const deps = stageSearch(location.search);
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
    const bound = live ? Object.values(liveSources(live)).flatMap((def) => boundSource(def, spot.bindings ?? {}) ?? []) : [];
    await Promise.all([
      queryClient.query(
        spotPreviewQuery(orgId, { orientation: deps.o ?? 'landscape', templateVersionId: spot.templateVersionId ?? undefined, brandKitId: deps.kit }),
      ),
      live && queryClient.query(dataSourcesQuery(orgId)),
      ...bound.map((id) => queryClient.query(dataSourceQuery(orgId, id))),
    ]);
  },
  head: () => ({ meta: [{ title: 'Spot · SignForge' }] }),
  component: SpotEditor,
});

function SpotEditor() {
  const orgId = useOrgId();
  const { spotId } = Route.useParams();
  const search = Route.useSearch();
  // The preview read for the orientation and kit shown: deferred, so a change keeps the stage until its own arrives.
  const previewSearch = useDeferredValue(search);
  const navigate = Route.useNavigate();
  const canManage = useCanManage();
  const canPublish = useCanPublish();
  const spot: SpotView | null = useSuspenseQuery(spotQuery(orgId, spotId)).data;
  const { templates } = useSuspenseQuery(templatesQuery(orgId)).data;
  const { assets } = useSuspenseQuery(assetsQuery(orgId)).data;
  const { brandKits } = useSuspenseQuery(brandKitsQuery(orgId)).data;
  // The stage draws the deferred orientation and kit, with the preview read for them: never one without the other.
  const orientation = previewSearch.o ?? 'landscape';
  const templateVersionId = spot?.templateVersionId ?? undefined;
  const preview = useSuspenseQuery(spotPreviewQuery(orgId, { orientation, templateVersionId, brandKitId: previewSearch.kit })).data;

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
  const reload = useAppStore((s) => s.reloadSpot);
  const pick = useAppStore((s) => s.pickImageFor);
  const publishing = useAppStore((s) => s.publishing.pending);
  const publish = useAppStore((s) => s.publishSpot);
  const checkAll = useAppStore((s) => s.checkAllFields);
  const filled = useAppStore((s) => s.agent.filled[spotId]);
  const clearMark = useAppStore((s) => s.clearFillMark);
  const finishFill = useAppStore((s) => s.finishFill);
  const undoFill = useAppStore((s) => s.undoFill);
  const fillWithAnother = useAppStore((s) => s.fillWithAnother);
  const takePhoto = useAppStore((s) => s.usePhotoFor);
  const reviewing = useAppStore((s) => s.agent.reviews[spotId] !== undefined);
  const openFill = useAppStore((s) => s.openSpotFill);
  const undoUpdate = useAppStore((s) => s.undoUpdate);
  const reviewAlsoOn = useAppStore((s) => s.reviewAlsoOn);
  const deleting = useAppStore((s) => s.spotEditor.deleting);
  const askDelete = useAppStore((s) => s.askDeleteSpot);
  const deleteSpot = useAppStore((s) => s.deleteSpot);

  if (!spot) return null;
  const draft = editing ?? draftOf(spot);
  const version = versionsById(templates).get(templateVersionId ?? '');
  const change = (c: (d: SpotDraft) => SpotDraft) => edit(orgId, spot.id, c);
  const set = (patch: Partial<SpotDraft>) => change((d) => ({ ...d, ...patch }));
  const range = version?.manifest.duration;
  const durationBad = range ? draft.durationMs < range.minMs || draft.durationMs > range.maxMs : draft.durationMs < 1000;
  const image = assets.find((a) => a.id === draft.assetId);
  const what = spot.kind === 'template' ? (version?.manifest.name ?? 'Template') : spot.kind === 'url' ? 'Web page' : spot.kind === 'image' ? 'Image' : 'Video';
  const setSearch = (next: Partial<StageSearch>) => void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });

  return (
    // Clipped, not hidden: an overflow-hidden box is a scroll container, so the review's action bar would stick to it, not the page.
    <div className={EDITOR}>
      <EditorHeader
        back={{ to: '/spots', label: 'Spots' }}
        title={draft.name || spot.name}
        about={`${what} · ${saveWord(status, savedAt)} · ${publishWord(spot)}`}
      >
        {canManage && spot.kind === 'template' && version && !reviewing && (
          <Button type="button" variant="outline" onClick={() => openFill(spotId)}>
            <SparklesIcon aria-hidden />
            Fill from a flyer
          </Button>
        )}
        {canPublish && (
          <PublishButton
            pending={publishing}
            disabled={stale}
            onPublish={() => {
              checkAll(spotId);
              void publish(orgId, spotId);
            }}
          />
        )}
        {canManage && <EditorMoreMenu onDelete={() => askDelete(true)} />}
      </EditorHeader>
      <SaveAlert error={saveError} stale={stale} onReload={() => void reload(orgId, spotId)} onRetry={() => void save(spotId)} />
      {/* An agent's edit is its proposal (#116): who, what it changes, Keep or Reject. */}
      <ProposalPanel
        orgId={orgId}
        kind="spot"
        id={spotId}
        version={spot.version}
        fieldLabels={Object.fromEntries(Object.entries(version?.manifest.fields ?? {}).map(([k, f]) => [k, f.label]))}
        unsaved={status !== 'saved'}
        canDecide={canManage}
      />
      {version && <FillSpotDialog orgId={orgId} spotId={spotId} fields={version.manifest.fields} />}
      {filled?.kind === 'update' && (
        <UpdateBanner
          changed={filled.changed ?? 0}
          undoable={Object.keys(filled.before ?? {}).length > 0}
          alsoOn={filled.alsoOn ?? []}
          onReview={(other) => {
            const o = filled.alsoOn?.find((x) => x.spotId === other);
            if (o) void reviewAlsoOn(orgId, spotId, o);
          }}
          onUndo={() => undoUpdate(orgId, spotId)}
          onDone={() => finishFill(spotId)}
        />
      )}
      {filled?.kind === 'new' && version && (
        <FillBanner
          marks={filled.marks}
          from={filled.photo ? 'photo' : 'link'}
          onUndo={() => undoFill(orgId, spotId, { name: version.manifest.name, data: startData(version.manifest.fields) })}
          onAnother={() => void fillWithAnother(orgId, spotId)}
          onDone={() => finishFill(spotId)}
        />
      )}
      <div className={EDITOR_ROW}>
        {reviewing && version && (
          <div className={cn(EDITOR_FORM, 'px-4 pt-5 sm:px-6')}>
            <FillReview spotId={spotId} fields={version.manifest.fields} />
          </div>
        )}
        <form
          hidden={reviewing && version !== undefined}
          aria-label="Spot fields"
          onSubmit={(e) => e.preventDefault()}
          className={cn(EDITOR_FORM, 'gap-6 px-4 pt-5 pb-8 sm:px-6')}
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
                  <FieldForm
                    spotId={spotId}
                    fields={version.manifest.fields}
                    shown={typedFields(version.manifest, draft.bindings)}
                    draft={draft}
                    assets={assets}
                    marks={filled?.marks}
                    sampleFields={spot.sampleFields}
                    flyer={
                      filled?.photo
                        ? { onUse: (field) => void takePhoto(orgId, spotId, field), uploading: filled.uploading, error: filled.uploadError }
                        : undefined
                    }
                    onChange={change}
                    onEdited={(field) => clearMark(spotId, field)}
                  />
                </EditorSection>
              ) : (
                <p className="text-sm text-muted-foreground">This spot's template is not available to this organization.</p>
              ))}
            {(spot.kind === 'image' || spot.kind === 'video') && (
              <EditorSection title={spot.kind === 'image' ? 'Image' : 'Video'}>
                <div className="flex items-center gap-3">
                  <div className="grid h-14 w-24 shrink-0 place-items-center overflow-hidden rounded-md bg-stage">
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
                    className="w-24 text-center tabular-nums"
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
        {/* While a review is open, a phone shows the stage playing the change first, the review under it. */}
        <div className={cn(STAGE_COLUMN, reviewing && 'max-sm:order-first')}>
          <PlayerStage
            target={{ orgId, spotId, orientation, templateVersionId, brandKitId: previewSearch.kit }}
            kits={brandKits}
            kitId={preview.brandKitId}
            search={search}
            onSearch={setSearch}
            bound={Object.keys(draft.bindings).length > 0}
            thumbnail={version && templateThumbnail(version.key)}
          />
        </div>
      </div>
      <EditorDeleteQuestion open={deleting.open} onOpenChange={askDelete}>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {spot.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its draft and its published version are deleted; its images and data sources stay. A spot a playlist plays, in its draft or on screens, cannot be
            deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div role="alert" className="flex flex-col gap-1 text-sm font-medium text-destructive empty:hidden">
          {deleting.error && <p>{deleting.error}</p>}
          {deleting.playlists.length > 0 && (
            <ul className="list-disc pl-5">
              {deleting.playlists.map((p) => (
                <li key={p.id}>
                  <Link to="/playlists/$playlistId" params={{ playlistId: p.id }} onClick={() => askDelete(false)} className="underline underline-offset-4">
                    {p.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={deleting.pending} onClick={() => void deleteSpot(orgId, spot.id)}>
            {deleting.pending ? 'Deleting…' : 'Delete'}
          </Button>
        </AlertDialogFooter>
      </EditorDeleteQuestion>
    </div>
  );
}
