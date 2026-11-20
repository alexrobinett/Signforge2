/**
 * The spot editor (canvas board Spot editor A): the draft being edited, its saves, and the stage,
 * the real player in an iframe fed through the preview channel (M3-36).
 *
 * A keystroke changes the spot's draft here. The stage gets it 40 ms later: the draft is compiled
 * in the browser (`compilePreview`) and posted to the player, so nothing on that path waits on the
 * network. A draft the compiler refuses is not posted, so the stage keeps the last valid frame.
 * Each spot's draft is a versioned draft (./versioned-draft.ts): its save to the server
 * (`update_spot`) waits a second after the last edit, sends the version the editor opened with as
 * `ifVersion`, chains the version each save returns, and writes the saved spot into the Query
 * cache. A save asked for while one runs (Save draft, Publish) waits for it and sends the latest
 * edit, and editing another spot sends the edit left waiting on this one.
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
import { orgOnScreen } from '~/lib/live';
import { madeByEditor } from '~/lib/live-data';
import { callTool, spotOf, ToolCallError, toolMessage } from '~/lib/tools';
import type { SliceCreator } from './store';
import { autosave, createVersionedDrafts, realClock, type Drafts } from './versioned-draft';

/** How long typing pauses before the stage redraws, and before the draft is saved. */
const STAGE_DELAY_MS = 40;
const SAVE_DELAY_MS = 1000;

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
  /** Each spot's draft, by spot id. One saved stays, so the page keeps showing what was typed. */
  drafts: Drafts<SpotDraft>;
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
  /** Changes the draft of `spot` in `orgId`, starting from its saved draft. */
  editSpot: (orgId: string, spot: SpotView, change: (d: SpotDraft) => SpotDraft) => void;
  /** Saves the spot's draft now (Save draft, Publish): resolves once the save in flight and this one are done. */
  saveSpotDraft: (spotId: string) => Promise<void>;
  /** After a refused save: reads the spot again and drops its draft, to edit what is there now. */
  reloadSpot: (orgId: string, spotId: string) => Promise<void>;
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
  drafts: {},
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
  const timers: { stage?: ReturnType<typeof setTimeout> } = {};
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
    const d = get().spotEditor.drafts[spot.id];
    const draft = d?.orgId === t.orgId ? d.edit : draftOf(spot);
    const version = spot.templateVersionId ? versionsById(templates).get(spot.templateVersionId) : undefined;
    const result = await compilePreview({ spot, draft, version, preview: preview.preview, assets, orientation: t.orientation, live: !t.fallback });
    const sources = !t.fallback ? [...new Set(Object.values(draft.bindings).map((b) => b.dataSourceId))] : [];
    // A table added just now has no snapshot until its first poll: the stage plays what the editor read from it.
    const latest = async (id: string): Promise<DataSnapshot[]> => {
      const r = await queryClient.query({ ...dataSourceQuery(t.orgId, id), staleTime: 'static' }).catch(() => null);
      if (r?.snapshot) return [r.snapshot];
      const table = get().readTables[id];
      const now = new Date().toISOString();
      return table ? [{ id, version: 0, fetchedAt: now, checkedAt: now, data: table }] : [];
    };
    return { ...result, data: (await Promise.all(sources.map(latest))).flat() };
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

  const later = (which: 'stage', ms: number, run: () => Promise<void>) => {
    clearTimeout(timers[which]);
    timers[which] = setTimeout(() => void run(), ms);
  };

  const drafts = createVersionedDrafts<SpotDraft>({
    state: { read: () => get().spotEditor.drafts, write: (change) => editor((e) => ({ ...e, drafts: change(e.drafts) })) },
    async save({ key: spotId, draft: { orgId, edit: d, version } }) {
      const spot = await queryClient.query({ ...spotQuery(orgId, spotId), staleTime: 'static' });
      if (!spot) throw new ToolCallError('not_found', 'This spot was deleted.');
      const kindFields =
        spot.kind === 'template'
          ? { data: d.data, assets: d.assets, bindings: d.bindings }
          : spot.kind === 'url'
            ? { url: d.url }
            : { fit: d.fit, ...(d.assetId ? { assetId: d.assetId } : {}) };
      const saved = spotOf(await callTool('update_spot', { spotId, name: d.name.trim(), durationMs: d.durationMs, ...kindFields, ifVersion: version }));
      queryClient.setQueryData(spotKeys.one(orgId, spotId), saved);
      void dropUnbound(orgId, spot, saved);
      void queryClient.invalidateQueries({ queryKey: spotKeys.all(orgId), exact: true });
      return { version: saved.version };
    },
    invalid: ({ orgId, edit }, spotId) => {
      const spot = savedSpot(orgId, spotId);
      return spot ? unsaveable(spot, edit, orgId) : false;
    },
    makeId: () => crypto.randomUUID(),
    currentOrg: () => orgOnScreen(router),
    clock: realClock,
  });
  const saveSoon = autosave(realClock, SAVE_DELAY_MS, (spotId) => drafts.save(spotId));

  return {
    spotEditor: initial,

    editSpot(orgId, spot, change) {
      // Another spot's edit, still waiting out its second: it is saved now, not left behind.
      for (const [spotId, d] of Object.entries(get().spotEditor.drafts)) if (spotId !== spot.id && d.status === 'unsaved') void drafts.save(spotId);
      drafts.edit(spot.id, { orgId, record: spot.id, version: spot.version, edit: draftOf(spot) }, change);
      later('stage', STAGE_DELAY_MS, redraw);
      saveSoon(spot.id);
    },

    async saveSpotDraft(spotId) {
      await drafts.save(spotId);
    },

    async reloadSpot(orgId, spotId) {
      drafts.drop(spotId);
      await queryClient.invalidateQueries({ queryKey: spotKeys.one(orgId, spotId) });
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
