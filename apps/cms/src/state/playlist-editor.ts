/**
 * The playlist editor: the draft being edited (its name, transition and spots in order), its
 * saves, making and deleting playlists, and what the stage plays.
 *
 * Every edit (a reorder, an added or removed spot, the transition) changes the draft here at once
 * and reaches the stage a moment later: the draft is compiled in the browser with each spot's saved
 * draft (`compilePlaylistPreview`) and played by the real player on the spot editor's stage
 * (src/state/spot-editor.ts). The save to the server (`update_playlist`) waits a second after the
 * last edit and sends the whole order with the version the editor opened with as `ifVersion`, so
 * an order made from an old read is refused rather than dropping someone else's change; each save
 * chains the version it returns. A removed spot can be put back from the toast (docs/research/cms-ux.md).
 */
import type { ScreenManifest } from '@signforge/contract';
import { toast } from 'sonner';
import { playlistDraftOf, type PlaylistDraft, type PlaylistView } from '~/lib/playlists';
import { compilePlaylistPreview, versionsById, type SpotPreview } from '~/lib/spots';
import { callTool, playlistOf, saveRefused, toolMessage } from '~/lib/tools';
import { playlistKeys, playlistQuery } from '~/queries/playlists';
import { assetsQuery, spotPreviewQuery, spotsQuery, templatesQuery } from '~/queries/spots';
import type { StageTarget } from './spot-editor';
import type { SliceCreator } from './store';

const SAVE_DELAY_MS = 1000;

type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'invalid';

interface PlaylistEditorState {
  /** The org and playlist the draft belongs to; another playlist's page starts from its own saved draft. */
  orgId: string | null;
  playlistId: string | null;
  draft: PlaylistDraft | null;
  /** The playlist's version the draft builds on: sent as `ifVersion`, moved on by each save. */
  version: number | null;
  status: SaveStatus;
  savedAt: number | null;
  saveError: string | null;
  /** The last save was refused because someone else changed the playlist: the editor offers a reload. */
  stale: boolean;
  /** Spots the stage leaves out, by id, with why: a screen could not play them yet. */
  leftOut: [string, string[]][];
  /** The spot picker: open, and its search. */
  adding: boolean;
  addQuery: string;
  /** The position of the spot being dragged, or null. */
  dragging: number | null;
  newPlaylist: { open: boolean; name: string; pending: boolean; error: string | null; key: string | null };
  deleting: { open: boolean; pending: boolean; error: string | null };
}

export interface PlaylistEditorSlice {
  playlistEditor: PlaylistEditorState;
  /** Changes the draft of `playlist`, starting from its saved draft if another playlist was open. */
  editPlaylist: (orgId: string, playlist: PlaylistView, change: (d: PlaylistDraft) => PlaylistDraft) => void;
  addSpotToPlaylist: (orgId: string, playlist: PlaylistView, spotId: string) => void;
  /** Removes the spot at `index`, with a toast that puts it back. */
  removeSpotFromPlaylist: (orgId: string, playlist: PlaylistView, index: number, name: string) => void;
  moveSpotInPlaylist: (orgId: string, playlist: PlaylistView, from: number, to: number) => void;
  startDragSpot: (index: number | null) => void;
  /** Drops the dragged spot at `index`. */
  dropSpot: (orgId: string, playlist: PlaylistView, index: number) => void;
  openAddSpots: (open: boolean) => void;
  searchAddSpots: (query: string) => void;
  /** Saves the draft now (the Save draft button), or once the save in flight is done. */
  savePlaylistDraft: () => Promise<void>;
  /** After a refused save: reads the playlist again and drops the draft, to edit what is there now. */
  reloadPlaylist: () => Promise<void>;
  /** The stage's manifest for a playlist target (called by the stage's redraw). */
  playlistStageDraft: (target: StageTarget & { playlistId: string }) => Promise<{ manifest?: ScreenManifest; problems: string[] } | undefined>;
  openNewPlaylist: (open: boolean) => void;
  nameNewPlaylist: (name: string) => void;
  /** Creates an empty playlist from the dialog and opens its editor. */
  createPlaylist: (orgId: string) => Promise<void>;
  askDeletePlaylist: (open: boolean) => void;
  deletePlaylist: (orgId: string, playlistId: string) => Promise<void>;
}

const closedNew = (): PlaylistEditorState['newPlaylist'] => ({ open: false, name: '', pending: false, error: null, key: null });
const closedDelete = (): PlaylistEditorState['deleting'] => ({ open: false, pending: false, error: null });

const initial: PlaylistEditorState = {
  orgId: null,
  playlistId: null,
  draft: null,
  version: null,
  status: 'saved',
  savedAt: null,
  saveError: null,
  stale: false,
  leftOut: [],
  adding: false,
  addQuery: '',
  dragging: null,
  newPlaylist: closedNew(),
  deleting: closedDelete(),
};

/** `list` with the item at `from` moved to `to`. */
function moved<T>(list: T[], from: number, to: number): T[] {
  const out = [...list];
  const [item] = out.splice(from, 1);
  if (item === undefined) return list;
  out.splice(to, 0, item);
  return out;
}

/** One compile input from the previews of several template versions: their templates and files together. */
const merged = (previews: SpotPreview[]): SpotPreview['preview'] =>
  previews.reduce<SpotPreview['preview']>(
    (all, p) => ({ ...p.preview, templates: { ...all.templates, ...p.preview.templates }, files: { ...all.files, ...p.preview.files } }),
    { templates: {}, files: {}, dataSources: [] },
  );

export const createPlaylistEditorSlice: SliceCreator<PlaylistEditorSlice> = (set, get, { router, queryClient }) => {
  const editor = (change: (e: PlaylistEditorState) => PlaylistEditorState) => set((s) => ({ playlistEditor: change(s.playlistEditor) }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving = false;

  const savedPlaylist = (orgId: string, playlistId: string) => queryClient.getQueryData(playlistQuery(orgId, playlistId).queryKey);
  const saveLater = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void get().savePlaylistDraft(), SAVE_DELAY_MS);
  };
  /** The draft of `playlist` as it stands: the one being edited, else the saved one. */
  const current = (playlist: PlaylistView) => {
    const e = get().playlistEditor;
    return e.playlistId === playlist.id && e.draft ? e.draft : playlistDraftOf(playlist);
  };

  return {
    playlistEditor: initial,

    editPlaylist(orgId, playlist, change) {
      editor((e) => {
        const fresh = e.playlistId !== playlist.id || !e.draft;
        // The picker stays as it is: the first spot added from it is the edit that starts the draft.
        const base = fresh ? { ...initial, adding: e.adding, addQuery: e.addQuery, orgId, playlistId: playlist.id, version: playlist.version } : e;
        return { ...base, draft: change(current(playlist)), status: 'unsaved', dragging: null };
      });
      get().redrawStage();
      saveLater();
    },

    addSpotToPlaylist: (orgId, playlist, spotId) => get().editPlaylist(orgId, playlist, (d) => ({ ...d, spotIds: [...d.spotIds, spotId] })),

    removeSpotFromPlaylist(orgId, playlist, index, name) {
      const before = current(playlist).spotIds;
      get().editPlaylist(orgId, playlist, (d) => ({ ...d, spotIds: d.spotIds.filter((_, i) => i !== index) }));
      toast(`Removed ${name}`, { action: { label: 'Undo', onClick: () => get().editPlaylist(orgId, playlist, (d) => ({ ...d, spotIds: before })) } });
    },

    moveSpotInPlaylist: (orgId, playlist, from, to) => get().editPlaylist(orgId, playlist, (d) => ({ ...d, spotIds: moved(d.spotIds, from, to) })),

    startDragSpot: (dragging) => editor((e) => ({ ...e, dragging })),

    dropSpot(orgId, playlist, index) {
      const from = get().playlistEditor.dragging;
      if (from === null || from === index) return get().startDragSpot(null);
      get().moveSpotInPlaylist(orgId, playlist, from, index);
    },

    openAddSpots: (adding) => editor((e) => ({ ...e, adding, addQuery: '' })),
    searchAddSpots: (addQuery) => editor((e) => ({ ...e, addQuery })),

    async savePlaylistDraft() {
      clearTimeout(timer);
      const { orgId, playlistId, draft, version, stale } = get().playlistEditor;
      if (!orgId || !playlistId || !draft || version === null || stale) return;
      if (saving) return saveLater();
      const t = draft.transition;
      if (!draft.name.trim() || (t.type !== 'cut' && !(t.ms >= 1 && t.ms <= 10_000))) {
        editor((e) => ({ ...e, status: 'invalid' }));
        return;
      }
      saving = true;
      editor((e) => ({ ...e, status: 'saving', saveError: null }));
      try {
        const saved = playlistOf(
          await callTool('update_playlist', { playlistId, name: draft.name.trim(), transition: draft.transition, spotIds: draft.spotIds, ifVersion: version }),
        );
        queryClient.setQueryData(playlistKeys.one(orgId, playlistId), saved);
        void queryClient.invalidateQueries({ queryKey: playlistKeys.all(orgId), exact: true });
        editor((e) => ({ ...e, version: saved.version, savedAt: Date.now(), status: e.draft === draft ? 'saved' : 'unsaved' }));
      } catch (err) {
        editor((e) => ({ ...e, status: 'unsaved', ...saveRefused(err) }));
      } finally {
        saving = false;
      }
      const after = get().playlistEditor;
      if (after.status === 'unsaved' && !after.saveError) saveLater();
    },

    async reloadPlaylist() {
      const { orgId, playlistId } = get().playlistEditor;
      clearTimeout(timer);
      editor(() => initial);
      if (orgId && playlistId) await queryClient.invalidateQueries({ queryKey: playlistKeys.one(orgId, playlistId) });
      get().redrawStage();
    },

    async playlistStageDraft(t) {
      const playlist = savedPlaylist(t.orgId, t.playlistId);
      const spots = queryClient.getQueryData(spotsQuery(t.orgId).queryKey)?.spots;
      const templates = queryClient.getQueryData(templatesQuery(t.orgId).queryKey)?.templates;
      const assets = queryClient.getQueryData(assetsQuery(t.orgId).queryKey)?.assets;
      if (!playlist || !spots || !templates || !assets) return undefined;
      const draft = current(playlist);
      const inPlaylist = new Set(draft.spotIds);
      const versionIds = [...new Set(spots.flatMap((s) => (inPlaylist.has(s.id) && s.templateVersionId ? [s.templateVersionId] : [])))];
      // One preview per template version, as the spot editor reads them, so the two share the cache.
      const previews = await Promise.all(
        (versionIds.length ? versionIds : [undefined]).map((templateVersionId) =>
          queryClient.query(spotPreviewQuery(t.orgId, { orientation: t.orientation, templateVersionId, brandKitId: t.brandKitId })),
        ),
      );
      const result = await compilePlaylistPreview({
        playlist: { id: playlist.id, ...draft },
        spots,
        versions: versionsById(templates),
        preview: merged(previews),
        assets,
        orientation: t.orientation,
      });
      editor((e) => ({ ...e, leftOut: [...result.leftOut] }));
      return result;
    },

    openNewPlaylist: (open) => editor((e) => ({ ...e, newPlaylist: { ...closedNew(), open } })),
    nameNewPlaylist: (name) => editor((e) => ({ ...e, newPlaylist: { ...e.newPlaylist, name, error: null } })),

    async createPlaylist(orgId) {
      const key = get().playlistEditor.newPlaylist.key ?? crypto.randomUUID();
      editor((e) => ({ ...e, newPlaylist: { ...e.newPlaylist, key, pending: true, error: null } }));
      try {
        const made = playlistOf(await callTool('create_playlist', { name: get().playlistEditor.newPlaylist.name.trim(), idempotencyKey: key }));
        queryClient.setQueryData(playlistKeys.one(orgId, made.id), made);
        void queryClient.invalidateQueries({ queryKey: playlistKeys.all(orgId), exact: true });
        await router.navigate({ to: '/playlists/$playlistId', params: { playlistId: made.id } });
        editor((e) => ({ ...e, newPlaylist: closedNew() }));
      } catch (err) {
        editor((e) => ({ ...e, newPlaylist: { ...e.newPlaylist, pending: false, error: toolMessage(err) } }));
      }
    },

    askDeletePlaylist: (open) => editor((e) => ({ ...e, deleting: { ...closedDelete(), open } })),

    async deletePlaylist(orgId, playlistId) {
      clearTimeout(timer);
      editor((e) => ({ ...e, deleting: { ...e.deleting, pending: true, error: null } }));
      try {
        await callTool('delete_playlist', { playlistId });
        await router.navigate({ to: '/playlists' });
        queryClient.removeQueries({ queryKey: playlistKeys.one(orgId, playlistId), exact: true });
        await queryClient.invalidateQueries({ queryKey: playlistKeys.all(orgId), exact: true });
        editor(() => initial);
      } catch (err) {
        editor((e) => ({ ...e, deleting: { ...e.deleting, pending: false, error: toolMessage(err) } }));
      }
    },
  };
};
