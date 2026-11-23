/**
 * The built-in agent's fill (#263, docs/proposals/cms-agent.md): a new spot from a flyer, a photo
 * or a link. The New spot dialog holds the photo chosen or the link pasted; the fill
 * (`POST /api/agent/inline`) makes the spot as a draft and opens its editor with its fields marked
 * (`filled`), until a field is edited or the person says Done. The photo is scaled down here
 * (`scaledPhoto`), and is kept only in this page, for "Use as the photo", which uploads it as any
 * image is. Nothing here outlives the page.
 */
import { FILL_IMAGE_EDGE, FILL_IMAGE_MAX_BYTES, type FieldMark, type InlineAnswer, type InlineRequest } from '@signforge/api/agent-inline';
import { MediaError, scaledPhoto, uploadImage } from '@signforge/media';
import { tabOrgHeaders } from '~/lib/tab-org';
import { answer, callToolByName, Refusal, toolMessage } from '~/lib/tools';
import { spotKeys } from '~/queries/spots';
import type { SliceCreator } from './store';

interface FillDraft {
  link: string;
  photo: File | null;
  pending: boolean;
  error: string | null;
  /** Whether an owner mends the error in Settings, AI & agents: the dialog links there. */
  inSettings: boolean;
  /** Try another template: the template is the one the person picks, not the model's choice. */
  again: boolean;
  /** The fill's idempotency key, made on the first try and kept for retries of the same material. */
  key: string | null;
}

/** A spot just filled: its fields' marks, and what it was filled from. */
interface Filled {
  marks: Record<string, FieldMark>;
  photo: File | null;
  link: string;
  /** "Use as the photo": its upload running, and why it failed. */
  uploading: boolean;
  uploadError: string | null;
}

interface AgentState {
  fill: FillDraft;
  /** By spot id. */
  filled: Record<string, Filled>;
}

export interface AgentSlice {
  agent: AgentState;
  /** A photo replaces a link and a link a photo: the fill reads one. */
  editFill: (change: { link: string } | { photo: File | null }) => void;
  /** The dialog closed: the photo or link and any error go. */
  forgetFill: () => void;
  /** Fills a new spot from the dialog's photo or link, with the template the model chooses or `templateVersionId`, and opens it. */
  fillNewSpot: (orgId: string, templateVersionId?: string) => Promise<void>;
  /** An edit of a filled field takes its mark away. */
  clearFillMark: (spotId: string, field: string) => void;
  /** Done: the marks go. */
  finishFill: (spotId: string) => void;
  /** Undo the fill: the spot named after its template, its data back to what a new spot starts with, no photo, and the marks gone. */
  undoFill: (orgId: string, spotId: string, start: { name: string; data: Record<string, unknown> }) => void;
  /** Try another template: the New spot dialog again, with the same material and a template to pick. */
  fillWithAnother: (spotId: string) => Promise<void>;
  /** Uploads the flyer's photo, as any image is, and puts it in the image field. */
  usePhotoFor: (orgId: string, spotId: string, field: string) => Promise<void>;
}

const newFill = (): FillDraft => ({ link: '', photo: null, pending: false, error: null, inSettings: false, again: false, key: null });

/** Problems an owner mends in Settings, AI & agents. */
const IN_SETTINGS = new Set(['no_model', 'cannot_fill', 'model_refused']);

const idOf = (asset: unknown) => (typeof asset === 'object' && asset !== null && 'id' in asset && typeof asset.id === 'string' ? asset.id : undefined);

export const createAgentSlice: SliceCreator<AgentSlice> = (set, get, { router, queryClient }) => {
  const agent = (change: (a: AgentState) => AgentState) => set((s) => ({ agent: change(s.agent) }));
  const fill = (change: (f: FillDraft) => FillDraft) => agent((a) => ({ ...a, fill: change(a.fill) }));
  const filled = (spotId: string, change: (f: Filled) => Filled | undefined) =>
    agent((a) => {
      const now = a.filled[spotId];
      if (!now) return a;
      const next = change(now);
      const { [spotId]: _gone, ...rest } = a.filled;
      return { ...a, filled: next ? { ...rest, [spotId]: next } : rest };
    });

  return {
    agent: { fill: newFill(), filled: {} },

    editFill: (change) =>
      fill((f) => ({ ...f, ...('photo' in change ? { photo: change.photo, link: '' } : { link: change.link, photo: null }), error: null, key: null })),

    forgetFill: () => fill(() => newFill()),

    async fillNewSpot(orgId, templateVersionId) {
      const key = get().agent.fill.key ?? crypto.randomUUID();
      fill((f) => ({ ...f, key, pending: true, error: null, inSettings: false }));
      const { photo, link } = get().agent.fill;
      try {
        let source: InlineRequest['source'];
        if (photo) {
          const scaled = await scaledPhoto(photo, FILL_IMAGE_EDGE).catch((err: unknown) => {
            throw err instanceof MediaError ? new Refusal('invalid_input', `Could not read the photo: ${err.message}.`, undefined, { cause: err }) : err;
          });
          if ((scaled.data.length / 4) * 3 > FILL_IMAGE_MAX_BYTES)
            throw new Refusal('invalid_input', 'The photo has too much detail to send. Try a closer or plainer one.');
          source = { kind: 'image', ...scaled };
        } else source = { kind: 'link', url: link.trim() };
        const request: InlineRequest = { source, idempotencyKey: key, ...(templateVersionId && { templateVersionId }) };
        const headers = { 'content-type': 'application/json', ...(await tabOrgHeaders()) };
        const res = await fetch('/api/agent/inline', { method: 'POST', headers, body: JSON.stringify(request) }).catch((cause: unknown) => {
          throw new Refusal('network', 'Could not reach SignForge. Check your connection and try again.', undefined, { cause });
        });
        const made = await answer<InlineAnswer>(res, `Something went wrong (${res.status}).`);
        queryClient.setQueryData(spotKeys.one(orgId, made.spot.id), made.spot);
        void queryClient.invalidateQueries({ queryKey: spotKeys.all(orgId), exact: true });
        // A retry of a fill that had made its spot gets it back with no marks (they were in the lost answer): nothing to mark.
        const marked = Object.keys(made.marks).length > 0;
        agent((a) => ({
          fill: newFill(),
          filled: marked ? { ...a.filled, [made.spot.id]: { marks: made.marks, photo, link, uploading: false, uploadError: null } } : a.filled,
        }));
        get().openNewSpot(false);
        await router.navigate({ to: '/spots/$spotId', params: { spotId: made.spot.id } });
      } catch (err) {
        fill((f) => ({ ...f, pending: false, error: toolMessage(err), inSettings: err instanceof Refusal && IN_SETTINGS.has(err.code) }));
      }
    },

    clearFillMark: (spotId, field) =>
      filled(spotId, (f) => {
        if (!(field in f.marks)) return f;
        const { [field]: _cleared, ...marks } = f.marks;
        return { ...f, marks };
      }),

    finishFill: (spotId) => filled(spotId, () => undefined),

    undoFill(orgId, spotId, start) {
      // The name is the model's too: the template's is what the spot is before anyone names it.
      get().editSpot(orgId, spotId, (d) => ({ ...d, name: start.name, data: start.data, assets: {} }));
      filled(spotId, () => undefined);
    },

    async fillWithAnother(spotId) {
      const was = get().agent.filled[spotId];
      if (!was) return;
      filled(spotId, () => undefined);
      get().openNewSpot(true);
      agent((a) => ({ ...a, fill: { ...newFill(), photo: was.photo, link: was.link, again: true } }));
      await router.navigate({ to: '/spots' });
    },

    async usePhotoFor(orgId, spotId, field) {
      const photo = get().agent.filled[spotId]?.photo;
      if (!photo) return;
      filled(spotId, (f) => ({ ...f, uploading: true, uploadError: null }));
      try {
        const { asset } = await uploadImage(photo, { callTool: callToolByName, idempotencyKey: `${spotId}/${field}` });
        const assetId = idOf(asset);
        if (!assetId) throw new Error('the upload gave no asset');
        await queryClient.invalidateQueries({ queryKey: ['org', orgId, 'assets'] });
        get().editSpot(orgId, spotId, (d) => ({ ...d, assets: { ...d.assets, [field]: assetId } }));
        filled(spotId, (f) => {
          const { [field]: _used, ...marks } = f.marks;
          return { ...f, marks, uploading: false };
        });
      } catch (err) {
        filled(spotId, (f) => ({ ...f, uploading: false, uploadError: toolMessage(err) }));
      }
    },
  };
};
