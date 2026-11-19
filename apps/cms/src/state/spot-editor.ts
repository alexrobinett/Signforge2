/**
 * The spot editor (canvas board Spot editor A): the draft being edited, its saves, and the stage,
 * the real player in an iframe fed through the preview channel (M3-36).
 *
 * A keystroke changes the draft here. The stage gets it 40 ms later: the draft is compiled in the
 * browser (`compilePreview`) and posted to the player, so nothing on that path waits on the
 * network. A draft the compiler refuses is not posted, so the stage keeps the last valid frame.
 * The save to the server (`update_spot`) waits a second after the last edit, sends the version the
 * editor opened with as `ifVersion`, chains the version each save returns, and writes the saved
 * spot into the Query cache.
 *
 * Which spot, orientation and kit the stage shows lives in the URL and the Query cache; the stage
 * component hands them over with `attachStage` from its ref callback. The playlist editor shows
 * its playlist on the same stage (a target with a `playlistId`): it compiles the draft
 * (`playlistStageDraft`, src/state/playlist-editor.ts) and asks for a redraw (`redrawStage`).
 *
 * A spot bound to data sources plays their latest snapshots, posted with the draft, as a screen
 * would; a new snapshot in the Query cache redraws it. With `fallback` (the stage's Data switch)
 * the draft is compiled without its bindings, so the stage shows the fallback values.
 */
import { type DataSnapshot, PREVIEW_PROTOCOL, safeUrl, type ScreenManifest } from '@signforge/contract';
import { playerMessage } from '~/lib/preview';
import { assetsQuery, dataSourceKeys, dataSourceQuery, spotKeys, spotPreviewQuery, spotQuery, templatesQuery } from '~/queries/spots';
import { compilePreview, draftOf, fieldProblems, versionsById, type SpotDraft, type SpotKind, type SpotView } from '~/lib/spots';
import { madeByEditor } from '~/lib/live-data';
import { callTool, saveRefused, spotOf, toolMessage } from '~/lib/tools';
import type { SliceCreator } from './store';

/** How long typing pauses before the stage redraws, and before the draft is saved. */
const STAGE_DELAY_MS = 40;
const SAVE_DELAY_MS = 1000;

type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'invalid';

/** What the stage shows, a spot or a playlist, as the stage component reads it from the URL. */
export type StageShows = {
  orgId: string;
  orientation: 'landscape' | 'portrait';
  brandKitId?: string;
} & (
  | {
      spotId: string;
      templateVersionId?: string;
      /** Play the spot's fallback values instead of its bound sources' data (the stage's Data switch). */
      fallback?: boolean;
    }
  | { playlistId: string }
);

/** Where the stage is and what it shows. */
export type StageTarget = StageShows & { frame: Window };

interface NewSpotDraft {
  open: boolean;
  kind: Exclude<SpotKind, 'video'>;
  templateVersionId: string | null;
  name: string;
  url: string;
  assetId: string | null;
  pending: boolean;
  error: string | null;
  /** The create's idempotency key, made on the first try and kept for retries. */
  key: string | null;
}

interface SpotEditorState {
  /** The spot the draft belongs to; another spot's page starts from its own saved draft. */
  spotId: string | null;
  draft: SpotDraft | null;
  /** The spot's version the draft builds on: sent as `ifVersion`, moved on by each save. */
  version: number | null;
  status: SaveStatus;
  savedAt: number | null;
  saveError: string | null;
  /** The last save was refused because someone else changed the spot: the editor offers a reload. */
  stale: boolean;
  /** The image field whose picker is open (`assetId` for an image spot), or null. */
  picking: string | null;
  /** True while the draft cannot be drawn: the stage keeps the last frame it drew. */
  holding: boolean;
  /** Whether the player has said it plays the draft. */
  playing: boolean;
  /** The spot the player last said is on screen. */
  playingSpot: string | null;
  /** What the player last said went wrong, or null once it plays. */
  stageError: string | null;
  /** The room the stage has on the page, for scaling the screen to fit; null until measured. */
  stageBox: { w: number; h: number } | null;
  newSpot: NewSpotDraft;
}

export interface SpotEditorSlice {
  spotEditor: SpotEditorState;
  /** Changes the draft of `spot`, starting from its saved draft if another spot was open. */
  editSpot: (spot: SpotView, change: (d: SpotDraft) => SpotDraft) => void;
  /** Saves the draft now (the Save draft button), or once the save in flight is done. */
  saveSpotDraft: () => Promise<void>;
  /** After a refused save: reads the spot again and drops the draft, to edit what is there now. */
  reloadSpot: () => Promise<void>;
  pickImageFor: (field: string | null) => void;
  /** The stage's iframe and what it should show; null when it unmounts. */
  attachStage: (target: StageTarget | null) => void;
  /** Draws what the stage shows again, a moment after the last call: after an edit of the playlist it shows. */
  redrawStage: () => void;
  measureStage: (box: { w: number; h: number }) => void;
  openNewSpot: (open: boolean) => void;
  editNewSpot: (change: Partial<Pick<NewSpotDraft, 'kind' | 'templateVersionId' | 'name' | 'url' | 'assetId'>>) => void;
  /** Creates the spot from the dialog's draft and opens its editor. */
  createSpot: (orgId: string, start?: { durationMs: number; data: Record<string, unknown> }) => Promise<void>;
}

const newSpotDraft = (): NewSpotDraft => ({
  open: false,
  kind: 'template',
  templateVersionId: null,
  name: '',
  url: '',
  assetId: null,
  pending: false,
  error: null,
  key: null,
});

const initial: SpotEditorState = {
  spotId: null,
  draft: null,
  version: null,
  status: 'saved',
  savedAt: null,
  saveError: null,
  stale: false,
  picking: null,
  holding: false,
  playing: false,
  playingSpot: null,
  stageError: null,
  stageBox: null,
  newSpot: newSpotDraft(),
};

/** The open stage, and the player window that has said it is listening. Outside state: not rendered. */
interface StageLink {
  target: StageTarget | null;
  listening: Window | null;
  /** Counts redraws, so a slow compile never posts over a newer one. */
  seq: number;
}

export const createSpotEditorSlice: SliceCreator<SpotEditorSlice> = (set, get, { router, queryClient }) => {
  const editor = (change: (e: SpotEditorState) => SpotEditorState) => set((s) => ({ spotEditor: change(s.spotEditor) }));
  const timers: { stage?: ReturnType<typeof setTimeout>; save?: ReturnType<typeof setTimeout> } = {};
  let saving = false;
  let hearing = false;

  const savedSpot = (orgId: string, spotId: string) => queryClient.getQueryData(spotQuery(orgId, spotId).queryKey);

  const sourcesOf = (s: SpotView) => new Set(Object.values(s.bindings ?? {}).map((b) => b.dataSourceId));

  /**
   * Deletes each weather source the editor made that the save stopped binding, so one nobody uses
   * no longer counts against the org's ten or gets polled; picking the place again makes it again.
   * A feed or calendar someone typed stays (`madeByEditor`). `delete_data_source` refuses one any
   * other spot's draft or published version still binds; that refusal, or any other, leaves the
   * source, which is all a failed cleanup costs.
   */
  async function dropUnbound(orgId: string, before: SpotView, after: SpotView) {
    const kept = sourcesOf(after);
    const dropped = [...sourcesOf(before)].filter((id) => !kept.has(id) && madeByEditor(id));
    if (!dropped.length) return;
    await Promise.allSettled(dropped.map((dataSourceId) => callTool('delete_data_source', { dataSourceId })));
    await queryClient.invalidateQueries({ queryKey: dataSourceKeys.all(orgId), exact: true });
  }

  /** Whether the server would refuse the draft (packages/tools `update_spot`): an empty image field is allowed. */
  const unsaveable = (spot: SpotView, d: SpotDraft, orgId: string) => {
    if (!d.name.trim()) return true;
    if (spot.kind === 'url') return !safeUrl(d.url);
    if (spot.kind !== 'template') return false;
    const v = versionsById(queryClient.getQueryData(templatesQuery(orgId).queryKey)?.templates ?? []).get(spot.templateVersionId ?? '');
    if (!v) return false;
    const { minMs, maxMs } = v.manifest.duration;
    if (d.durationMs < minMs || d.durationMs > maxMs) return true;
    return [...fieldProblems(v.manifest.fields, d).keys()].some((name) => v.manifest.fields[name]?.type !== 'image' || name in d.assets);
  };

  /** The spot target's draft, compiled; undefined while what it needs is not loaded. */
  async function spotDraft(
    t: StageTarget & { spotId: string; fallback?: boolean },
  ): Promise<{ manifest?: ScreenManifest; problems: string[]; data?: DataSnapshot[] } | undefined> {
    const spot = savedSpot(t.orgId, t.spotId);
    const preview = queryClient.getQueryData(spotPreviewQuery(t.orgId, t).queryKey);
    const templates = queryClient.getQueryData(templatesQuery(t.orgId).queryKey)?.templates;
    const assets = queryClient.getQueryData(assetsQuery(t.orgId).queryKey)?.assets;
    if (!spot || !preview || !templates || !assets) return undefined;
    const e = get().spotEditor;
    const draft = e.spotId === spot.id && e.draft ? e.draft : draftOf(spot);
    const version = spot.templateVersionId ? versionsById(templates).get(spot.templateVersionId) : undefined;
    const result = await compilePreview({ spot, draft, version, preview: preview.preview, assets, orientation: t.orientation, live: !t.fallback });
    const sources = !t.fallback ? [...new Set(Object.values(draft.bindings).map((b) => b.dataSourceId))] : [];
    const read = await Promise.all(sources.map((id) => queryClient.query({ ...dataSourceQuery(t.orgId, id), staleTime: 'static' }).catch(() => null)));
    return { ...result, data: read.flatMap((r) => (r?.snapshot ? [r.snapshot] : [])) };
  }

  async function redraw() {
    const t = stage.target;
    if (!t || stage.listening !== t.frame) return;
    const seq = ++stage.seq;
    let result: Awaited<ReturnType<typeof spotDraft>>;
    try {
      result = 'playlistId' in t ? await get().playlistStageDraft(t) : await spotDraft(t);
    } catch (err) {
      // A playlist's previews are read here, not in its loader: one that fails is said on the stage.
      if (seq === stage.seq) editor((x) => ({ ...x, stageError: `what it needs did not load (${toolMessage(err)})` }));
      return;
    }
    if (!result || seq !== stage.seq || stage.target?.frame !== t.frame) return;
    if (!result.manifest) {
      editor((x) => ({ ...x, holding: true }));
      return;
    }
    t.frame.postMessage({ sfPreview: PREVIEW_PROTOCOL, type: 'draft', manifest: result.manifest, data: result.data ?? [] }, location.origin);
    editor((x) => ({ ...x, holding: false }));
  }

  const stage: StageLink = { target: null, listening: null, seq: 0 };

  /** What the stage's player says. Only the attached frame, on this origin, is listened to. */
  const hear = (e: MessageEvent) => {
    if (e.origin !== location.origin || !stage.target || e.source !== stage.target.frame) return;
    const msg = playerMessage(e.data);
    if (msg?.type === 'listening') {
      stage.listening = stage.target.frame;
      void redraw();
    } else if (msg?.type === 'playing') editor((x) => ({ ...x, playing: true, playingSpot: msg.spot, stageError: null }));
    else if (msg?.type === 'error') editor((x) => ({ ...x, stageError: msg.message }));
  };

  const later = (which: 'stage' | 'save', ms: number, run: () => Promise<void>) => {
    clearTimeout(timers[which]);
    timers[which] = setTimeout(() => void run(), ms);
  };

  return {
    spotEditor: initial,

    editSpot(spot, change) {
      editor((e) => {
        const fresh = e.spotId !== spot.id || !e.draft;
        const base = fresh ? { ...initial, newSpot: e.newSpot, stageBox: e.stageBox, spotId: spot.id, version: spot.version } : e;
        return { ...base, draft: change(fresh ? draftOf(spot) : (e.draft ?? draftOf(spot))), status: 'unsaved' };
      });
      later('stage', STAGE_DELAY_MS, redraw);
      later('save', SAVE_DELAY_MS, get().saveSpotDraft);
    },

    async saveSpotDraft() {
      clearTimeout(timers.save);
      const t = stage.target;
      const { spotId, draft, version, stale } = get().spotEditor;
      if (!t || !('spotId' in t) || !spotId || !draft || version === null || stale || t.spotId !== spotId) return;
      const spot = savedSpot(t.orgId, spotId);
      if (!spot) return;
      if (saving) {
        later('save', SAVE_DELAY_MS, get().saveSpotDraft);
        return;
      }
      if (unsaveable(spot, draft, t.orgId)) {
        editor((e) => ({ ...e, status: 'invalid' }));
        return;
      }
      saving = true;
      editor((e) => ({ ...e, status: 'saving', saveError: null }));
      // The answer belongs to this spot: another opened meanwhile has its own draft and version.
      const open = () => get().spotEditor.spotId === spotId;
      const kindFields =
        spot.kind === 'template'
          ? { data: draft.data, assets: draft.assets, bindings: draft.bindings }
          : spot.kind === 'url'
            ? { url: draft.url }
            : { fit: draft.fit, ...(draft.assetId ? { assetId: draft.assetId } : {}) };
      try {
        const saved = spotOf(
          await callTool('update_spot', { spotId, name: draft.name.trim(), durationMs: draft.durationMs, ...kindFields, ifVersion: version }),
        );
        queryClient.setQueryData(spotKeys.one(t.orgId, spotId), saved);
        void dropUnbound(t.orgId, spot, saved);
        void queryClient.invalidateQueries({ queryKey: spotKeys.all(t.orgId), exact: true });
        if (open()) editor((e) => ({ ...e, version: saved.version, savedAt: Date.now(), status: e.draft === draft ? 'saved' : 'unsaved' }));
      } catch (err) {
        if (open()) editor((e) => ({ ...e, status: 'unsaved', ...saveRefused(err) }));
      } finally {
        saving = false;
      }
      const after = get().spotEditor;
      if (open() && after.status === 'unsaved' && !after.saveError) later('save', SAVE_DELAY_MS, get().saveSpotDraft);
    },

    async reloadSpot() {
      const t = stage.target;
      clearTimeout(timers.save);
      editor((e) => ({ ...initial, newSpot: e.newSpot, stageBox: e.stageBox }));
      if (t && 'spotId' in t) await queryClient.invalidateQueries({ queryKey: spotKeys.one(t.orgId, t.spotId) });
      await redraw();
    },

    pickImageFor: (picking) => editor((e) => ({ ...e, picking })),

    attachStage(target) {
      // Called from a ref callback, so only in the browser; the listener is added once.
      if (target && !hearing) {
        window.addEventListener('message', hear);
        // A source's new snapshot (its query read again) redraws the stage with it.
        queryClient.getQueryCache().subscribe((event) => {
          const key = event.query.queryKey;
          if (event.type === 'updated' && event.action.type === 'success' && key[2] === 'dataSources' && key.length === 4)
            later('stage', STAGE_DELAY_MS, redraw);
        });
        hearing = true;
      }
      const changed = stage.target?.frame !== target?.frame;
      stage.target = target;
      if (changed) editor((e) => ({ ...e, holding: false, playing: false, playingSpot: null, stageError: null }));
      void redraw();
    },

    redrawStage: () => later('stage', STAGE_DELAY_MS, redraw),

    measureStage: (stageBox) => editor((e) => ({ ...e, stageBox })),

    openNewSpot: (open) => editor((e) => ({ ...e, newSpot: open ? { ...newSpotDraft(), open } : newSpotDraft() })),
    editNewSpot: (change) => editor((e) => ({ ...e, newSpot: { ...e.newSpot, ...change, error: null } })),

    async createSpot(orgId, start) {
      const key = get().spotEditor.newSpot.key ?? crypto.randomUUID();
      editor((e) => ({ ...e, newSpot: { ...e.newSpot, key, pending: true, error: null } }));
      const d = get().spotEditor.newSpot;
      const kind =
        d.kind === 'template'
          ? { kind: 'template', templateVersionId: d.templateVersionId, ...start }
          : d.kind === 'url'
            ? { kind: 'url', url: d.url.trim() }
            : { kind: 'image', assetId: d.assetId };
      try {
        const spot = spotOf(await callTool('create_spot', { name: d.name.trim(), ...kind, idempotencyKey: key }));
        queryClient.setQueryData(spotKeys.one(orgId, spot.id), spot);
        void queryClient.invalidateQueries({ queryKey: spotKeys.all(orgId), exact: true });
        await router.navigate({ to: '/spots/$spotId', params: { spotId: spot.id } });
        editor((e) => ({ ...e, newSpot: newSpotDraft() }));
      } catch (err) {
        editor((e) => ({ ...e, newSpot: { ...e.newSpot, pending: false, error: toolMessage(err) } }));
      }
    },
  };
};
