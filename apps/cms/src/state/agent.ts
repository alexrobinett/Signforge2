/**
 * The built-in agent's fill (#263, docs/proposals/cms-agent.md): a new spot from a flyer, a photo
 * or a link. The New spot dialog holds the photo chosen or the link pasted; the fill
 * (`POST /api/agent/inline`) makes the spot as a draft and opens its editor with its fields marked
 * (`filled`), until a field is edited or the person says Done. The photo is scaled down here
 * (`scaledPhoto`), and is kept only in this page, for "Use as the photo", which uploads it as any
 * image is. Nothing here outlives the page.
 *
 * In the editor (#264) the same fill reads a spot that exists: the draft is saved first, and the API
 * says what it would change, writing nothing (`reviews`). The stage plays the change while the review
 * is open. Keep writes it (`POST /api/agent/inline/keep`) at the version it was made on: a save made
 * since is kept and the review offers Reload. Undo puts back what Keep changed, as an edit.
 */
import {
  FILL_IMAGE_EDGE,
  FILL_IMAGE_MAX_BYTES,
  type FieldMark,
  type InlineAnswer,
  type InlineRequest,
  type InlineReview,
  type KeepRequest,
} from '@signforge/api/agent-inline';
import type { FieldDef } from '@signforge/contract';
import { alsoOn, fillChanges, type AlsoOn } from '~/lib/fill-changes';
import { versionsById, type SpotView } from '~/lib/spots';
import { MediaError, scaledPhoto, uploadImage } from '@signforge/media';
import { tabOrgHeaders } from '~/lib/tab-org';
import { answer, callToolByName, Refusal, toolMessage } from '~/lib/tools';
import { spotKeys, spotsQuery, templatesQuery } from '~/queries/spots';
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
  /**
   * The fill's idempotency key, made on the first try and kept for retries of the same material and
   * template pick: a new pick is a new fill, which the API would refuse under the old key (#314).
   */
  key: { id: string; templateVersionId: string | null } | null;
}

/** A spot just filled or updated: its fields' marks, and what it was filled from. */
interface Filled {
  /** A new spot (#263), or one updated by Keep (#264), whose Undo puts back `before`. */
  kind: 'new' | 'update';
  marks: Record<string, FieldMark>;
  /** An update's changed fields as they were. */
  before?: Record<string, unknown>;
  /** An update's changed rows on other spots, each offered the same review. */
  alsoOn?: AlsoOn[];
  photo: File | null;
  link: string;
  /** "Use as the photo": its upload running, and why it failed. */
  uploading: boolean;
  uploadError: string | null;
}

/** What an update would change, until it is kept or let go (#264). */
export interface Review {
  orgId: string;
  version: number;
  before: Record<string, unknown>;
  data: Record<string, unknown>;
  marks: Record<string, FieldMark>;
  from: 'photo' | 'link' | 'spot';
  /** For a review of another spot's same rows: the spot it came from. */
  fromSpot?: string;
  alsoOn: AlsoOn[];
  keeping: boolean;
  error: string | null;
  /** Someone saved the spot since it was read: their change is kept, and the review offers Reload. */
  stale: boolean;
}

interface AgentState {
  fill: FillDraft;
  /** The spot whose Fill from a flyer dialog is open, or null. */
  fillingSpot: string | null;
  /** By spot id. */
  filled: Record<string, Filled>;
  /** By spot id. */
  reviews: Record<string, Review>;
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
  /** Opens or closes the editor's Fill from a flyer dialog for a spot (#264). */
  openSpotFill: (spotId: string | null) => void;
  /** Saves the draft, then asks what the dialog's photo or link would change in it: a review, nothing written. */
  reviewFill: (orgId: string, spotId: string, fields: Record<string, FieldDef>) => Promise<void>;
  /** Writes the review, as the agent's, at the version it was made on. */
  keepReview: (spotId: string, fields: Record<string, FieldDef>) => Promise<void>;
  /** Lets the review go and opens the dialog again for another photo or link. */
  retakeFill: (spotId: string) => void;
  /** Lets the review go. */
  discardReview: (spotId: string) => void;
  /** After a refused Keep: lets the review go and reads the spot as someone saved it. */
  reloadReviewed: (spotId: string) => Promise<void>;
  /** Opens another spot with the same rows changed, in its own review. */
  reviewAlsoOn: (orgId: string, fromSpot: string, other: AlsoOn) => Promise<void>;
  /** Undo an update: each field Keep changed back to what it was, as an edit; the marks gone. */
  undoUpdate: (orgId: string, spotId: string) => void;
}

/** A review's changed fields' marks once kept: the agent's for each, a check where it said to check. */
const keptMarks = (fields: Record<string, FieldDef>, r: Review) =>
  Object.fromEntries(fillChanges(fields, r.before, r.data).map((c): [string, FieldMark] => [c.field, r.marks[c.field] ?? { state: 'filled' }]));

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

  const reviews = (spotId: string, change: (r: Review) => Review | undefined) =>
    agent((a) => {
      const now = a.reviews[spotId];
      if (!now) return a;
      const next = change(now);
      const { [spotId]: _gone, ...rest } = a.reviews;
      return { ...a, reviews: next ? { ...rest, [spotId]: next } : rest };
    });

  /** The dialog's photo, scaled here, or its link: what the fill reads. */
  async function sourceOf(photo: File | null, link: string): Promise<InlineRequest['source']> {
    if (!photo) return { kind: 'link', url: link.trim() };
    const scaled = await scaledPhoto(photo, FILL_IMAGE_EDGE).catch((err: unknown) => {
      throw err instanceof MediaError ? new Refusal('invalid_input', `Could not read the photo: ${err.message}.`, undefined, { cause: err }) : err;
    });
    if ((scaled.data.length / 4) * 3 > FILL_IMAGE_MAX_BYTES)
      throw new Refusal('invalid_input', 'The photo has too much detail to send. Try a closer or plainer one.');
    return { kind: 'image', ...scaled };
  }

  /** A POST to one of the agent's routes, naming the tab's org; its answer, or its refusal thrown. */
  async function post<T>(path: string, body: InlineRequest | KeepRequest): Promise<T> {
    const headers = { 'content-type': 'application/json', ...(await tabOrgHeaders()) };
    const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) }).catch((cause: unknown) => {
      throw new Refusal('network', 'Could not reach SignForge. Check your connection and try again.', undefined, { cause });
    });
    return answer<T>(res, `Something went wrong (${res.status}).`);
  }

  const failed = (err: unknown) =>
    fill((f) => ({ ...f, pending: false, error: toolMessage(err), inSettings: err instanceof Refusal && IN_SETTINGS.has(err.code) }));

  return {
    agent: { fill: newFill(), fillingSpot: null, filled: {}, reviews: {} },

    editFill: (change) =>
      fill((f) => ({ ...f, ...('photo' in change ? { photo: change.photo, link: '' } : { link: change.link, photo: null }), error: null, key: null })),

    forgetFill: () => fill(() => newFill()),

    async fillNewSpot(orgId, templateVersionId) {
      const kept = get().agent.fill.key;
      const pick = templateVersionId ?? null;
      const key = kept?.templateVersionId === pick ? kept : { id: crypto.randomUUID(), templateVersionId: pick };
      fill((f) => ({ ...f, key, pending: true, error: null, inSettings: false }));
      const { photo, link } = get().agent.fill;
      try {
        const source = await sourceOf(photo, link);
        const made = await post<InlineAnswer>('/api/agent/inline', { source, idempotencyKey: key.id, ...(templateVersionId && { templateVersionId }) });
        queryClient.setQueryData(spotKeys.one(orgId, made.spot.id), made.spot);
        void queryClient.invalidateQueries({ queryKey: spotKeys.all(orgId), exact: true });
        // A retry of a fill that had made its spot gets it back with no marks (they were in the lost answer): nothing to mark.
        const marked = Object.keys(made.marks).length > 0;
        agent((a) => ({
          ...a,
          fill: newFill(),
          filled: marked ? { ...a.filled, [made.spot.id]: { kind: 'new', marks: made.marks, photo, link, uploading: false, uploadError: null } } : a.filled,
        }));
        get().openNewSpot(false);
        await router.navigate({ to: '/spots/$spotId', params: { spotId: made.spot.id } });
      } catch (err) {
        failed(err);
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

    openSpotFill: (spotId) => agent((a) => ({ ...a, fillingSpot: spotId, fill: newFill() })),

    async reviewFill(orgId, spotId, fields) {
      fill((f) => ({ ...f, pending: true, error: null, inSettings: false }));
      const { photo, link } = get().agent.fill;
      try {
        // What is typed is saved first: the review is of the draft as it is now, and nothing of it is the agent's.
        await get().saveSpotDraft(spotId);
        const source = await sourceOf(photo, link);
        const { review } = await post<InlineReview>('/api/agent/inline', { source, spotId });
        // Where else a changed row is, from the org's spots and templates as the Spots page reads them: a help, so a
        // read that fails offers none rather than failing the review.
        const changes = fillChanges(fields, review.before, review.data);
        const others = await Promise.all([queryClient.fetchQuery(spotsQuery(orgId)), queryClient.fetchQuery(templatesQuery(orgId))]).then(
          ([spots, templates]) => alsoOn(spotId, fields, review.data, changes, spots.spots, versionsById(templates.templates)),
          (): AlsoOn[] => [],
        );
        agent((a) => ({
          ...a,
          fill: newFill(),
          fillingSpot: null,
          reviews: {
            ...a.reviews,
            [spotId]: { orgId, ...review, from: photo ? 'photo' : 'link', alsoOn: others, keeping: false, error: null, stale: false },
          },
        }));
        get().redrawStage();
      } catch (err) {
        failed(err);
      }
    },

    async keepReview(spotId, fields) {
      const r = get().agent.reviews[spotId];
      if (!r || r.keeping) return;
      reviews(spotId, (x) => ({ ...x, keeping: true, error: null }));
      try {
        const { spot } = await post<{ spot: SpotView }>('/api/agent/inline/keep', { spotId, ifVersion: r.version, data: r.data });
        queryClient.setQueryData(spotKeys.one(r.orgId, spotId), spot);
        void queryClient.invalidateQueries({ queryKey: spotKeys.all(r.orgId), exact: true });
        const changed = fillChanges(fields, r.before, r.data).map((c) => c.field);
        agent((a) => {
          const { [spotId]: _kept, ...rest } = a.reviews;
          const before = Object.fromEntries(changed.map((f) => [f, r.before[f]]));
          return {
            ...a,
            reviews: rest,
            filled: {
              ...a.filled,
              [spotId]: { kind: 'update', marks: keptMarks(fields, r), before, alsoOn: r.alsoOn, photo: null, link: '', uploading: false, uploadError: null },
            },
          };
        });
        // The editor's own draft was of the version before: the page shows the spot as kept.
        await get().reloadSpot(r.orgId, spotId);
      } catch (err) {
        const stale = err instanceof Refusal && err.code === 'conflict';
        reviews(spotId, (x) => ({
          ...x,
          keeping: false,
          stale,
          error: stale ? 'Someone saved this spot since it was read. Their change is kept: reload it, then fill again.' : toolMessage(err),
        }));
      }
    },

    retakeFill(spotId) {
      reviews(spotId, () => undefined);
      agent((a) => ({ ...a, fillingSpot: spotId, fill: newFill() }));
      get().redrawStage();
    },

    discardReview(spotId) {
      reviews(spotId, () => undefined);
      get().redrawStage();
    },

    async reloadReviewed(spotId) {
      const r = get().agent.reviews[spotId];
      reviews(spotId, () => undefined);
      if (r) await get().reloadSpot(r.orgId, spotId);
    },

    async reviewAlsoOn(orgId, fromSpot, other) {
      const review: Review = {
        orgId,
        version: other.version,
        before: other.before,
        data: other.data,
        marks: {},
        from: 'spot',
        fromSpot,
        alsoOn: [],
        keeping: false,
        error: null,
        stale: false,
      };
      agent((a) => ({ ...a, reviews: { ...a.reviews, [other.spotId]: review } }));
      await router.navigate({ to: '/spots/$spotId', params: { spotId: other.spotId } });
    },

    undoUpdate(orgId, spotId) {
      const before = get().agent.filled[spotId]?.before;
      if (before) get().editSpot(orgId, spotId, (d) => ({ ...d, data: { ...d.data, ...before } }));
      filled(spotId, () => undefined);
    },
  };
};
