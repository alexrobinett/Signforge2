/**
 * The playlist editor: the draft being edited (its name, transition and spots in order), its
 * saves, making and deleting playlists, and what the stage plays.
 *
 * Every edit (a reorder, an added or removed spot, the transition) changes the draft here at once
 * and reaches the stage a moment later: the draft is compiled in the browser with each spot's saved
 * draft (`compilePlaylistPreview`) and played by the real player on the spot editor's stage
 * (src/state/spot-editor.ts). The save to the server (`update_playlist`) waits a second after the
 * last edit and sends the whole order with the version the editor opened with as `ifVersion`, so
 * an order made from an old read is refused rather than dropping someone else's change. Saves run
 * one at a time, each for the playlist it was made for: a save builds on the version the one before
 * it returned for that playlist, its answer reaches the editor only while that playlist is still
 * open, and a draft waiting to be saved is sent before another playlist is edited. A removed spot
 * can be put back from the toast (docs/research/cms-ux.md).
 */
import type { ScreenManifest } from '@signforge/contract';
import { toast } from 'sonner';
import { playlistDraftOf, rowKeys, type PlaylistDraft, type PlaylistView } from '~/lib/playlists';
import { compilePlaylistPreview, versionsById, type SpotPreview } from '~/lib/spots';
import { callTool, isGone, playlistOf, saveRefused, toolMessage } from '~/lib/tools';
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
  /** The playlist was deleted, by someone else or in another tab: nothing more is saved. */
  gone: boolean;
  /** Spots the stage leaves out, by id, with why: a screen could not play them yet. */
  leftOut: [string, string[]][];
  /** The spot picker: open, and its search. */
  adding: boolean;
  addQuery: string;
  /** The position of the spot being dragged, or null. */
  dragging: number | null;
  /** After a move by its buttons: the moved row (`rowKeys`) and which of its buttons takes focus. */
  focusAfterMove: { row: string; button: 'up' | 'down' } | null;
  /** Where the last move by its buttons put the spot, for a polite live region. */
  moved: string;
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
  /** A move by a row's up or down button: focus stays on the moved row, and its new place is said. */
  moveSpotByButton: (orgId: string, playlist: PlaylistView, from: number, to: number, name: string) => void;
  /** The moved row's button has taken focus. */
  focusMoved: () => void;
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
  gone: false,
  leftOut: [],
  adding: false,
  addQuery: '',
  dragging: null,
  focusAfterMove: null,
  moved: '',
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

/** A draft to save, with the playlist it belongs to. */
interface Pending {
  orgId: string;
  playlistId: string;
  draft: PlaylistDraft;
  version: number;
}

/** Why a draft cannot be saved as it is: no name, or a transition length a screen would refuse. */
const unsaveable = ({ name, transition: t }: PlaylistDraft) => !name.trim() || (t.type !== 'cut' && !(t.ms >= 1 && t.ms <= 10_000));

/** One compile input from the previews of several template versions: their templates and files together. */
const merged = (previews: SpotPreview[]): SpotPreview['preview'] =>
  previews.reduce<SpotPreview['preview']>(
    (all, p) => ({ ...p.preview, templates: { ...all.templates, ...p.preview.templates }, files: { ...all.files, ...p.preview.files } }),
    { templates: {}, files: {}, dataSources: [] },
  );

export const createPlaylistEditorSlice: SliceCreator<PlaylistEditorSlice> = (set, get, { router, queryClient }) => {
  const editor = (change: (e: PlaylistEditorState) => PlaylistEditorState) => set((s) => ({ playlistEditor: change(s.playlistEditor) }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The saves, run one at a time in the order they were asked for. */
  let queue: Promise<void> = Promise.resolve();
  /** The version each playlist's last save returned, so a save queued behind it builds on it. Versions only grow. */
  const savedVersions = new Map<string, number>();

  const savedPlaylist = (orgId: string, playlistId: string) => queryClient.getQueryData(playlistQuery(orgId, playlistId).queryKey);
  const saveLater = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void get().savePlaylistDraft(), SAVE_DELAY_MS);
  };
  /** The edit being made, if it is waiting to be saved. */
  const waiting = (): Pending | undefined => {
    const { orgId, playlistId, draft, version, status, stale, gone } = get().playlistEditor;
    if (!orgId || !playlistId || !draft || version === null || status !== 'unsaved' || stale || gone || unsaveable(draft)) return undefined;
    return { orgId, playlistId, draft, version };
  };

  async function send(p: Pending) {
    const open = () => get().playlistEditor.playlistId === p.playlistId;
    const ifVersion = Math.max(p.version, savedVersions.get(p.playlistId) ?? 0);
    try {
      const { name, transition, spotIds } = p.draft;
      const saved = playlistOf(await callTool('update_playlist', { playlistId: p.playlistId, name: name.trim(), transition, spotIds, ifVersion }));
      savedVersions.set(p.playlistId, saved.version);
      const key = playlistKeys.one(p.orgId, p.playlistId);
      // A playlist deleted meanwhile has left the cache: it is not written back.
      if (queryClient.getQueryData(key)) queryClient.setQueryData(key, saved);
      void queryClient.invalidateQueries({ queryKey: playlistKeys.all(p.orgId), exact: true });
      if (open()) editor((e) => ({ ...e, version: saved.version, savedAt: Date.now(), status: e.draft === p.draft ? 'saved' : 'unsaved' }));
    } catch (err) {
      if (open()) editor((e) => (isGone(err) ? { ...e, status: 'unsaved', gone: true, saveError: null } : { ...e, status: 'unsaved', ...saveRefused(err) }));
    }
    const after = get().playlistEditor;
    if (open() && after.status === 'unsaved' && !after.saveError && !after.gone) saveLater();
  }

  /** Queues the save of `p`, after any save already asked for. */
  const enqueue = (p: Pending) => {
    queue = queue.then(() => send(p));
    return queue;
  };

  /** The draft of `playlist` as it stands: the one being edited, else the saved one. */
  const current = (playlist: PlaylistView) => {
    const e = get().playlistEditor;
    return e.playlistId === playlist.id && e.draft ? e.draft : playlistDraftOf(playlist);
  };

  return {
    playlistEditor: initial,

    editPlaylist(orgId, playlist, change) {
      const before = get().playlistEditor.playlistId;
      // Another playlist's edit, still waiting out its second: it is saved, not dropped.
      const left = before !== playlist.id ? waiting() : undefined;
      if (left) void enqueue(left);
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
      const spotId = current(playlist).spotIds[index];
      if (spotId === undefined) return;
      get().editPlaylist(orgId, playlist, (d) => ({ ...d, spotIds: d.spotIds.toSpliced(index, 1) }));
      // Back at its place in the order as it is by then, so what was done since stays; only while this playlist is open.
      const undo = () => {
        if (get().playlistEditor.playlistId !== playlist.id) return;
        get().editPlaylist(orgId, playlist, (d) => ({ ...d, spotIds: d.spotIds.toSpliced(Math.min(index, d.spotIds.length), 0, spotId) }));
      };
      toast(`Removed ${name}`, { action: { label: 'Undo', onClick: undo } });
    },

    moveSpotInPlaylist: (orgId, playlist, from, to) => get().editPlaylist(orgId, playlist, (d) => ({ ...d, spotIds: moved(d.spotIds, from, to) })),

    moveSpotByButton(orgId, playlist, from, to, name) {
      get().moveSpotInPlaylist(orgId, playlist, from, to);
      const order = current(playlist).spotIds;
      const row = rowKeys(order)[to];
      if (row === undefined) return;
      // The pressed button, unless the row reached that end and it is disabled: then the other one.
      const button = to === 0 ? 'down' : to === order.length - 1 ? 'up' : to < from ? 'up' : 'down';
      editor((e) => ({ ...e, focusAfterMove: order.length > 1 ? { row, button } : null, moved: `${name}, ${to + 1} of ${order.length}` }));
    },

    focusMoved: () => editor((e) => ({ ...e, focusAfterMove: null })),

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
      const { draft, stale, gone } = get().playlistEditor;
      if (!draft || stale || gone) return;
      if (unsaveable(draft)) {
        editor((e) => ({ ...e, status: 'invalid' }));
        return;
      }
      const p = waiting();
      // Nothing waiting: done once the save in flight, if any, is.
      if (!p) return queue;
      editor((e) => ({ ...e, status: 'saving', saveError: null }));
      await enqueue(p);
    },

    async reloadPlaylist() {
      const { orgId, playlistId } = get().playlistEditor;
      clearTimeout(timer);
      editor(() => initial);
      if (playlistId) savedVersions.delete(playlistId);
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
        // Every preview is the same org's: one time zone.
        timezone: previews[0]!.timezone,
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
      editor((e) => ({ ...e, deleting: { ...e.deleting, pending: true, error: null } }));
      try {
        await callTool('delete_playlist', { playlistId });
        // Only once it is gone: a refused delete leaves the waiting save to run.
        clearTimeout(timer);
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
