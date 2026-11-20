/**
 * The playlist editor, laid out as the spot editor is (canvas board Spot editor A): the playlist's
 * name, spots in play order and transition beside the stage, where the real player plays the
 * loop. Spots are reordered by dragging, or by the move buttons from the keyboard and on a phone.
 * Every change goes to the stage at once and to the draft a moment later
 * (src/state/playlist-editor.ts). The stage's orientation, scale and brand kit are in the URL,
 * as the spot editor's are.
 */
import type { Transition } from '@signforge/contract';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, GripVerticalIcon, PlusIcon, Trash2Icon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { useCallback } from 'react';
import { SpotPicker } from '~/components/playlists/spot-picker';
import { EditorFields, EditorHeader, EditorSection, PublishButton, SaveAlert, SaveDraftButton, saveWord } from '~/components/editor';
import { PlayerStage, stageSearch, type StageSearch } from '~/components/spots/player-stage';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog';
import { Alert, AlertDescription } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { useCanManage, useCanPublish, useOrgId } from '~/lib/live';
import { clockLength, loopMs, playlistDraftOf, playlistPublishWord, rowKeys, type PlaylistView } from '~/lib/playlists';
import { seconds, spotWhat, versionsById } from '~/lib/spots';
import { cn } from '~/lib/utils';
import { playlistQuery } from '~/queries/playlists';
import { assetsQuery, brandKitsQuery, spotsQuery, templatesQuery } from '~/queries/spots';
import { useAppStore } from '~/state/provider';

export const Route = createFileRoute('/_app/playlists/$playlistId')({
  validateSearch: stageSearch,
  loader: async ({ context: { queryClient }, params, parentMatchPromise }) => {
    const orgId = (await parentMatchPromise).loaderData?.organization?.id;
    if (!orgId) return;
    const [playlist] = await Promise.all([
      queryClient.query(playlistQuery(orgId, params.playlistId)),
      queryClient.query(spotsQuery(orgId)),
      queryClient.query(templatesQuery(orgId)),
      queryClient.query(assetsQuery(orgId)),
      queryClient.query(brandKitsQuery(orgId)),
    ]);
    if (!playlist) throw notFound();
  },
  head: () => ({ meta: [{ title: 'Playlist · SignForge' }] }),
  component: PlaylistEditor,
});

/** A new transition of `type`, keeping the length of a fade or crossfade it replaces. */
function transitionOf(type: Transition['type'], was: Transition): Transition {
  if (type === 'cut') return { type };
  return { type, ms: was.type === 'cut' ? 500 : was.ms };
}

const TRANSITIONS: { type: Transition['type']; label: string; about: string }[] = [
  { type: 'cut', label: 'Cut', about: 'Instant. Templates animate their own intro and outro, so this already looks smooth.' },
  { type: 'fade', label: 'Fade', about: 'Out to black, then in: one spot on screen at a time. Smooth on any screen.' },
  {
    type: 'crossfade',
    label: 'Crossfade',
    about:
      'Both spots on screen while one fades over the other. That doubles the drawing work for its length: a Raspberry Pi 4 drops about 1 frame in 10 while it runs.',
  },
];

function PlaylistEditor() {
  const orgId = useOrgId();
  const { playlistId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const canManage = useCanManage();
  const canPublish = useCanPublish();
  const playlist: PlaylistView | null = useSuspenseQuery(playlistQuery(orgId, playlistId)).data;
  const { spots } = useSuspenseQuery(spotsQuery(orgId)).data;
  const { templates } = useSuspenseQuery(templatesQuery(orgId)).data;
  const { brandKits } = useSuspenseQuery(brandKitsQuery(orgId)).data;

  const saved = useAppStore((s) => s.playlistEditor.drafts[playlistId]);
  const mine = saved?.orgId === orgId ? saved : undefined;
  const editing = mine?.edit ?? null;
  const status = mine?.status ?? 'saved';
  const savedAt = mine?.savedAt ?? null;
  const saveError = mine?.error ?? null;
  const stale = mine?.stale ?? false;
  const gone = mine?.gone ?? false;
  const leftOutList = useAppStore((s) => s.playlistEditor.leftOut);
  const dragging = useAppStore((s) => s.playlistEditor.dragging);
  const deleting = useAppStore((s) => s.playlistEditor.deleting);
  const playingSpot = useAppStore((s) => s.spotEditor.playingSpot);
  const edit = useAppStore((s) => s.editPlaylist);
  const add = useAppStore((s) => s.addSpotToPlaylist);
  const remove = useAppStore((s) => s.removeSpotFromPlaylist);
  const move = useAppStore((s) => s.moveSpotByButton);
  const focusAfterMove = useAppStore((s) => s.playlistEditor.focusAfterMove);
  const moved = useAppStore((s) => s.playlistEditor.moved);
  const focusMoved = useAppStore((s) => s.focusMoved);
  // Given only to the moved row's button, as its ref: React moves the row's node, which loses focus.
  const takeFocus = useCallback(
    (el: HTMLButtonElement | null) => {
      if (!el) return;
      el.focus();
      focusMoved();
    },
    [focusMoved],
  );
  const startDrag = useAppStore((s) => s.startDragSpot);
  const drop = useAppStore((s) => s.dropSpot);
  const openAdd = useAppStore((s) => s.openAddSpots);
  const save = useAppStore((s) => s.savePlaylistDraft);
  const reload = useAppStore((s) => s.reloadPlaylist);
  const askDelete = useAppStore((s) => s.askDeletePlaylist);
  const deletePlaylist = useAppStore((s) => s.deletePlaylist);
  const publishing = useAppStore((s) => s.publishing.pending);
  const publish = useAppStore((s) => s.publishPlaylist);
  const makeDefault = useAppStore((s) => s.makeDefaultPlaylist);

  if (!playlist) return null;
  const draft = editing ?? playlistDraftOf(playlist);
  const byId = new Map(spots.map((s) => [s.id, s]));
  const versions = versionsById(templates);
  const leftOut = new Map(leftOutList);
  const rows = rowKeys(draft.spotIds);
  const counts = new Map<string, number>();
  for (const id of draft.spotIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  const t = draft.transition;
  const msBad = t.type !== 'cut' && !(t.ms >= 1 && t.ms <= 10_000);
  const change = (patch: Partial<typeof draft>) => edit(orgId, playlist, (d) => ({ ...d, ...patch }));
  const setSearch = (next: Partial<StageSearch>) => void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });
  const count = draft.spotIds.length === 1 ? '1 spot' : `${draft.spotIds.length} spots`;
  const loop = clockLength(loopMs(draft.spotIds, byId));
  const kitId = search.kit ?? brandKits.find((k) => k.isDefault)?.id ?? null;

  return (
    <div className="flex min-h-[calc(100dvh-8rem)] flex-col overflow-clip rounded-xl border">
      <EditorHeader
        back={{ to: '/playlists', label: 'Playlists' }}
        title={draft.name || playlist.name}
        about={`${count} · ${loop} loop · ${saveWord(status, savedAt)} · ${playlistPublishWord(playlist)}`}
      >
        {canManage && (
          <>
            <SaveDraftButton status={status} stale={stale} onSave={() => void save(playlistId)} />
            <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => askDelete(true)}>
              <Trash2Icon aria-hidden />
              Delete
            </Button>
          </>
        )}
        {canPublish && <PublishButton pending={publishing} disabled={stale || gone} onPublish={() => void publish(orgId, playlist.id)} />}
      </EditorHeader>
      <SaveAlert error={saveError} stale={stale} onReload={() => void reload(orgId, playlistId)} />
      {gone && (
        <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            This playlist was deleted, by someone else or in another tab. Your changes here are not saved.
            <Link to="/playlists" className="font-medium underline underline-offset-4">
              Back to playlists
            </Link>
          </AlertDescription>
        </Alert>
      )}
      <div className="flex flex-1 flex-wrap items-stretch">
        <form
          aria-label="Playlist"
          onSubmit={(e) => e.preventDefault()}
          className="flex max-w-full min-w-0 flex-[1_1_360px] flex-col gap-6 border-r bg-card px-4 pt-5 pb-8 sm:px-6"
        >
          <EditorFields disabled={!canManage}>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="playlist-name" className="font-medium">
                Name
              </label>
              <Input
                id="playlist-name"
                value={draft.name}
                maxLength={100}
                onChange={(e) => change({ name: e.target.value })}
                aria-invalid={!draft.name.trim() || undefined}
              />
            </div>
            <EditorSection title="Spots">
              <p className="text-sm text-muted-foreground">Each plays for its own duration, then the loop starts again. The spot on the stage is marked.</p>
              <p role="status" className="sr-only">
                {moved}
              </p>
              {draft.spotIds.length > 0 && (
                <ol aria-label="Spots in play order" className="flex flex-col gap-1.5">
                  {draft.spotIds.map((id, i) => {
                    const row = rows[i] ?? id;
                    const focusOn = (button: 'up' | 'down') => (focusAfterMove?.row === row && focusAfterMove.button === button ? takeFocus : undefined);
                    const spot = byId.get(id);
                    const name = spot?.name ?? 'A spot no longer in the library';
                    const why = leftOut.get(id);
                    return (
                      <li
                        key={row}
                        draggable={canManage}
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = 'move';
                          e.dataTransfer.setData('text/plain', String(i));
                          startDrag(i);
                        }}
                        onDragOver={(e) => {
                          if (dragging !== null) e.preventDefault();
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          drop(orgId, playlist, i);
                        }}
                        onDragEnd={() => startDrag(null)}
                        // The player names the spot, not its place: a spot listed twice is marked once, at its first place.
                        aria-current={row === `${playingSpot}#0` || undefined}
                        className={cn(
                          'flex min-h-12 items-center gap-2 rounded-lg border bg-card py-1 pr-1 pl-2',
                          playingSpot === id && 'border-primary bg-accent',
                          dragging === i && 'opacity-50',
                          dragging !== null && dragging !== i && 'border-dashed',
                        )}
                      >
                        {canManage && <GripVerticalIcon className="size-4 shrink-0 cursor-grab text-muted-foreground" aria-hidden />}
                        <span className="w-6 shrink-0 text-right font-mono text-xs text-muted-foreground">{i + 1}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{name}</span>
                          <span className="block truncate text-sm text-muted-foreground">
                            {spot ? `${spotWhat(spot, versions)} · ${seconds(spot.durationMs)} s` : ''}
                          </span>
                          {why && (
                            <span className="flex items-start gap-1.5 text-sm text-[#b54708] dark:text-[#fdb022]">
                              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                              <span>Not in the preview yet: {why.join('; ')}</span>
                            </span>
                          )}
                        </span>
                        {canManage && (
                          <span className="flex shrink-0">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="size-9"
                              disabled={i === 0}
                              ref={focusOn('up')}
                              onClick={() => move(orgId, playlist, i, i - 1, name)}
                              aria-label={`Move ${name} up`}
                            >
                              <ArrowUpIcon aria-hidden />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="size-9"
                              disabled={i === draft.spotIds.length - 1}
                              ref={focusOn('down')}
                              onClick={() => move(orgId, playlist, i, i + 1, name)}
                              aria-label={`Move ${name} down`}
                            >
                              <ArrowDownIcon aria-hidden />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="size-9"
                              onClick={() => remove(orgId, playlist, i, name)}
                              aria-label={`Remove ${name}`}
                            >
                              <XIcon aria-hidden />
                            </Button>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
              {canManage && (
                <Button type="button" variant="outline" className="self-start" onClick={() => openAdd(true)}>
                  <PlusIcon aria-hidden />
                  Add spots
                </Button>
              )}
              <SpotPicker spots={spots} versions={versions} counts={counts} onAdd={(s) => add(orgId, playlist, s.id)} />
            </EditorSection>
            <EditorSection title="Where it plays">
              {playlist.isDefault ? (
                <p className="flex items-start gap-2 text-sm">
                  <CheckIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                  The default playlist: every screen plays it when no schedule says otherwise.
                </p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    Screens play the default playlist when no schedule says otherwise. Until there is one, publishing reaches no screen.
                  </p>
                  {canPublish && (
                    <Button type="button" variant="outline" className="self-start" disabled={publishing} onClick={() => void makeDefault(orgId, playlist.id)}>
                      Play on every screen
                    </Button>
                  )}
                </>
              )}
            </EditorSection>
            <EditorSection title="Transition">
              <div className="flex flex-col gap-2">
                {TRANSITIONS.map((o) => (
                  <label key={o.type} className="flex gap-3 rounded-lg border p-3 has-checked:border-primary has-checked:bg-accent">
                    <input
                      type="radio"
                      name="playlist-transition"
                      checked={t.type === o.type}
                      onChange={() => change({ transition: transitionOf(o.type, t) })}
                      className="mt-1 accent-primary"
                    />
                    <span>
                      <span className="block font-medium">{o.label}</span>
                      <span className="block text-sm text-muted-foreground">{o.about}</span>
                    </span>
                  </label>
                ))}
              </div>
              {t.type !== 'cut' && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-3">
                    <label htmlFor="playlist-transition-ms" className="font-medium">
                      Length
                    </label>
                    <span className="flex items-center gap-2">
                      <Input
                        id="playlist-transition-ms"
                        type="number"
                        inputMode="decimal"
                        min={0.1}
                        max={10}
                        step={0.1}
                        value={t.ms / 1000}
                        onChange={(e) =>
                          change({ transition: { type: t.type, ms: Number.isNaN(e.target.valueAsNumber) ? 0 : Math.round(e.target.valueAsNumber * 1000) } })
                        }
                        className="w-24 text-center font-mono"
                        aria-invalid={msBad || undefined}
                        aria-describedby="playlist-transition-help"
                      />
                      <span className="text-sm text-muted-foreground">s</span>
                    </span>
                  </div>
                  <p id="playlist-transition-help" className={msBad ? 'text-sm font-medium text-destructive' : 'text-sm text-muted-foreground'}>
                    {msBad
                      ? 'Between 0.1 and 10 seconds.'
                      : t.type === 'fade'
                        ? 'Half of it fading out, half fading in. It overlaps the end of each spot, so the loop is no longer.'
                        : 'It overlaps the end of each spot, so the loop is no longer.'}
                  </p>
                </div>
              )}
            </EditorSection>
          </EditorFields>
        </form>
        {/* The form can be far longer than a spot's, so the stage stays in view beside it as it scrolls. */}
        <div className="flex min-w-0 flex-[999_1_560px] flex-col bg-[#18181a] lg:sticky lg:top-0 lg:h-[calc(100dvh-8rem)] lg:self-start">
          {draft.spotIds.length ? (
            <PlayerStage
              target={{ orgId, playlistId, orientation: search.o ?? 'landscape', brandKitId: search.kit }}
              kits={brandKits}
              kitId={kitId}
              search={search}
              onSearch={setSearch}
            />
          ) : (
            <section aria-label="Live preview" className="flex flex-1 items-center justify-center bg-[#18181a] p-8 text-center text-[#c8c8c8]">
              Add spots and the player plays the loop here.
            </section>
          )}
        </div>
      </div>
      <AlertDialog open={deleting.open} onOpenChange={askDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {playlist.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its draft and its published version are deleted; its spots stay in the library. A playlist a schedule plays, or the default playlist, cannot be
              deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p role="alert" className="text-sm font-medium text-destructive empty:hidden">
            {deleting.error}
          </p>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={deleting.pending} onClick={() => void deletePlaylist(orgId, playlist.id)}>
              {deleting.pending ? 'Deleting…' : 'Delete'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
