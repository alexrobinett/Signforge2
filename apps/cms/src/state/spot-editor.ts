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
 * component hands them over with `attachStage` from its ref callback.
 */
import { PREVIEW_PROTOCOL, safeUrl } from '@signforge/contract';
import { playerMessage } from '~/lib/preview';
import { assetsQuery, spotKeys, spotPreviewQuery, spotQuery, templatesQuery } from '~/queries/spots';
import { compilePreview, draftOf, fieldProblems, versionsById, type SpotDraft, type SpotKind, type SpotView } from '~/lib/spots';
import { callTool, isStale, spotOf, toolMessage } from '~/lib/tools';
import type { SliceCreator } from './store';

/** How long typing pauses before the stage redraws, and before the draft is saved. */
const STAGE_DELAY_MS = 40;
const SAVE_DELAY_MS = 1000;

type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'invalid';

/** Where the stage is and what it shows: from the stage component, which reads them from the URL. */
export interface StageTarget {
  frame: Window;
  orgId: string;
  spotId: string;
  orientation: 'landscape' | 'portrait';
  templateVersionId?: string;
  brandKitId?: string;
}

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

  async function redraw() {
    const t = stage.target;
    if (!t || stage.listening !== t.frame) return;
    const seq = ++stage.seq;
    const spot = savedSpot(t.orgId, t.spotId);
    const preview = queryClient.getQueryData(spotPreviewQuery(t.orgId, t).queryKey);
    const templates = queryClient.getQueryData(templatesQuery(t.orgId).queryKey)?.templates;
    const assets = queryClient.getQueryData(assetsQuery(t.orgId).queryKey)?.assets;
    if (!spot || !preview || !templates || !assets) return;
    const e = get().spotEditor;
    const draft = e.spotId === spot.id && e.draft ? e.draft : draftOf(spot);
    const version = spot.templateVersionId ? versionsById(templates).get(spot.templateVersionId) : undefined;
    const result = await compilePreview({ spot, draft, version, preview: preview.preview, assets, orientation: t.orientation });
    if (seq !== stage.seq || stage.target?.frame !== t.frame) return;
    if (!result.manifest) {
      editor((x) => ({ ...x, holding: true }));
      return;
    }
    t.frame.postMessage({ sfPreview: PREVIEW_PROTOCOL, type: 'draft', manifest: result.manifest }, location.origin);
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
    } else if (msg?.type === 'playing') editor((x) => ({ ...x, playing: true, stageError: null }));
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
      if (!t || !spotId || !draft || version === null || stale || t.spotId !== spotId) return;
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
      const kindFields =
        spot.kind === 'template'
          ? { data: draft.data, assets: draft.assets }
          : spot.kind === 'url'
            ? { url: draft.url }
            : { fit: draft.fit, ...(draft.assetId ? { assetId: draft.assetId } : {}) };
      try {
        const saved = spotOf(
          await callTool('update_spot', { spotId, name: draft.name.trim(), durationMs: draft.durationMs, ...kindFields, ifVersion: version }),
        );
        queryClient.setQueryData(spotKeys.one(t.orgId, spotId), saved);
        void queryClient.invalidateQueries({ queryKey: spotKeys.all(t.orgId), exact: true });
        editor((e) => ({ ...e, version: saved.version, savedAt: Date.now(), status: e.draft === draft ? 'saved' : 'unsaved' }));
      } catch (err) {
        editor((e) =>
          isStale(err)
            ? { ...e, status: 'unsaved', stale: true, saveError: 'This changed since you opened it.' }
            : { ...e, status: 'unsaved', saveError: toolMessage(err) },
        );
      } finally {
        saving = false;
      }
      if (get().spotEditor.status === 'unsaved' && !get().spotEditor.saveError) later('save', SAVE_DELAY_MS, get().saveSpotDraft);
    },

    async reloadSpot() {
      const t = stage.target;
      clearTimeout(timers.save);
      editor((e) => ({ ...initial, newSpot: e.newSpot, stageBox: e.stageBox }));
      if (t) await queryClient.invalidateQueries({ queryKey: spotKeys.one(t.orgId, t.spotId) });
      await redraw();
    },

    pickImageFor: (picking) => editor((e) => ({ ...e, picking })),

    attachStage(target) {
      // Called from a ref callback, so only in the browser; the listener is added once.
      if (target && !hearing) {
        window.addEventListener('message', hear);
        hearing = true;
      }
      const changed = stage.target?.frame !== target?.frame;
      stage.target = target;
      if (changed) editor((e) => ({ ...e, holding: false, playing: false, stageError: null }));
      void redraw();
    },

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
