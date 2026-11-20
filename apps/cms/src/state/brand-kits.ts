/**
 * The brand kit pages (canvas boards SettingsBrandKits and Idea 11): the kit being edited, its
 * save, the kit actions (new, duplicate, default, assign), and the previews, the org's own spots
 * on the real player, each in an iframe fed through the preview channel (M3-36).
 *
 * An edit changes the draft here; 40 ms later each preview's spot is compiled in the browser with
 * the draft kit laid over its preview input (`withDraftKit`) and posted to its player, so a colour
 * re-themes the spots without a round trip. Kits have no drafts on the server: Save sends the whole
 * draft to `update_brand_kit` with the version it was read at, and screens get it at their next
 * publish. Each kit keeps its own draft and errors here, so moving to another kit loses nothing.
 * Kit and assignment changes invalidate the kit list, whose `reach` they change.
 */
import { DEFAULT_BRAND_COLORS } from '@signforge/compiler';
import { PREVIEW_PROTOCOL, type BrandColor, type ScreenManifest } from '@signforge/contract';
import { duplicateInput, kitDraftOf, pairFix, shownColors, updateInput, withDraftKit, type BrandKitView, type KitDraft } from '~/lib/brand-kits';
import { playerMessage } from '~/lib/preview';
import { compilePreview, draftOf, versionsById, type SpotPreview } from '~/lib/spots';
import { brandKitIdOf, brandKitVersionOf, callTool, isStale, toolMessage } from '~/lib/tools';
import { assetsQuery, brandKitsQuery, spotPreviewQuery, spotsQuery, templatesQuery } from '~/queries/spots';
import type { SliceCreator } from './store';

const PREVIEW_DELAY_MS = 40;

/**
 * How long a draft may go unanswered before the next is posted anyway: past the player's 2 s ready
 * timeout, after which it answers with an error.
 */
const DRAFT_ANSWER_MS = 3000;

/** A new kit's colours: the palette screens use with no kit, its on-colours left to be derived. */
const NEW_KIT_COLORS = Object.fromEntries(Object.entries(DEFAULT_BRAND_COLORS).filter(([name]) => name !== 'onPrimary' && name !== 'onAccent'));

/** One preview's player and the spot it plays: from the preview component, which reads them from the page. */
export interface KitPreviewTarget {
  frame: Window;
  orgId: string;
  kitId: string;
  spotId: string;
  templateVersionId: string;
}

/** One kit's edit on this page: its draft until saved or discarded, and how its last save went. */
export interface KitEdit {
  draft: KitDraft | null;
  saving: boolean;
  savedAt: number | null;
  error: string | null;
  /** The last save was refused because someone else changed the kit: the editor offers a reload. */
  stale: boolean;
  /** The kit's version the draft builds on: sent as `ifVersion`, moved on by each save. Null with no draft. */
  version: number | null;
}

/** A kit with nothing edited yet; one object, so a selector that falls back to it re-renders nothing. */
export const NO_EDIT: KitEdit = { draft: null, saving: false, savedAt: null, error: null, stale: false, version: null };

interface BrandKitsState {
  /** Each kit's edit, by kit id. */
  edits: Record<string, KitEdit>;
  /** Which logo's picker is open. */
  logoFor: 'dark' | 'light' | null;
  /**
   * The kit action running (`default:<kit>`, `duplicate:<kit>`, `assign:<group or screen>`), or
   * null. While one runs, another is ignored; its controls say so with `aria-disabled`, since a
   * disabled control loses keyboard focus.
   */
  pending: string | null;
  /** Why the last kit action failed, for the kit whose page or row it was started from. */
  actionError: { kitId: string; text: string } | null;
  newKit: { open: boolean; name: string; pending: boolean; error: string | null; key: string | null };
  /** What each preview's player last said, by spot id. */
  previews: Record<string, { playing: boolean; error: string | null }>;
  /** The width each preview has on the page, for scaling the screen to fit; null until measured. */
  previewWidth: number | null;
}

export interface BrandKitsSlice {
  brandKits: BrandKitsState;
  /** Changes the draft of `kit`, starting from its saved values. */
  editKit: (kit: BrandKitView, change: (d: KitDraft) => KitDraft) => void;
  /** Gives the foreground of a failing pair its fix: a derived on-colour, or text moved until it reads. */
  fixKitPair: (kit: BrandKitView, fg: BrandColor, bg: BrandColor) => void;
  discardKitDraft: (kitId: string) => void;
  saveKit: (orgId: string, kit: BrandKitView) => Promise<void>;
  /** After a refused save: reads the kits again and drops the kit's draft. */
  reloadKit: (orgId: string, kitId: string) => Promise<void>;
  pickLogo: (which: 'dark' | 'light' | null) => void;
  openNewKit: (open: boolean) => void;
  nameNewKit: (name: string) => void;
  /** Creates a kit with the no-kit palette and opens it. */
  createKit: (orgId: string) => Promise<void>;
  /** Makes a copy and opens it. A retry after a lost answer sends the same key, so it never makes two. */
  duplicateKit: (orgId: string, kit: BrandKitView) => Promise<void>;
  makeDefaultKit: (orgId: string, kitId: string) => Promise<void>;
  /** Gives a group or a screen `kit` (`chosen`), or takes its choice away. */
  assignKit: (orgId: string, kit: BrandKitView, chosen: boolean, target: { groupId: string } | { screenId: string }) => Promise<void>;
  /** A preview's iframe and what it plays; null when it unmounts. */
  attachKitPreview: (spotId: string, target: KitPreviewTarget | null) => void;
  measureKitPreview: (width: number) => void;
}

const newKit = () => ({ open: false, name: '', pending: false, error: null, key: null });

const initial: BrandKitsState = {
  edits: {},
  logoFor: null,
  pending: null,
  actionError: null,
  newKit: newKit(),
  previews: {},
  previewWidth: null,
};

/** One preview's player. Outside state: not rendered. */
interface PreviewLink {
  target: KitPreviewTarget;
  /** Counts redraws, so a slow compile never posts over a newer one. */
  seq: number;
  /** The newest draft compiled while the player had one unanswered: sent when it answers. */
  next: { manifest: ScreenManifest; seq: number } | null;
}

export const createBrandKitsSlice: SliceCreator<BrandKitsSlice> = (set, get, { router, queryClient }) => {
  const kits = (change: (k: BrandKitsState) => BrandKitsState) => set((s) => ({ brandKits: change(s.brandKits) }));
  const edit = (kitId: string, change: (e: KitEdit) => KitEdit) => kits((k) => ({ ...k, edits: { ...k.edits, [kitId]: change(k.edits[kitId] ?? NO_EDIT) } }));
  const links = new Map<string, PreviewLink>();
  // A player says it is listening once per load. Its frame can be attached again for another kit
  // (the route stays mounted after Duplicate), so the frames that said it are kept, not the links.
  const heard = new WeakSet<Window>();
  // Players with a draft not answered yet. Two updates can finish out of order (Slot.update awaits
  // fonts), leaving the older kit on screen: one draft at a time per frame, kit switches included.
  // A queued draft stays on its link, so a left kit's is never sent.
  const busy = new Map<Window, ReturnType<typeof setTimeout>>();
  // Duplicate's key per kit and version being copied, until the copy is made: a retry must not make
  // a second, and copying the kit after it changed is a new creation with a new key.
  const duplicateKeys = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hearing = false;

  async function redraw(link: PreviewLink) {
    const t = link.target;
    if (!heard.has(t.frame)) return;
    const seq = ++link.seq;
    const kit = queryClient.getQueryData(brandKitsQuery(t.orgId).queryKey)?.brandKits.find((k) => k.id === t.kitId);
    const spot = queryClient.getQueryData(spotsQuery(t.orgId).queryKey)?.spots.find((x) => x.id === t.spotId);
    const templates = queryClient.getQueryData(templatesQuery(t.orgId).queryKey)?.templates;
    const assets = queryClient.getQueryData(assetsQuery(t.orgId).queryKey)?.assets;
    if (!kit || !spot || !templates || !assets) return;
    // The page observes the reads above. Nothing observes this one, so Query drops it after a while,
    // and a save invalidates it: read it through the client, which fetches it again when it must.
    let preview: SpotPreview;
    try {
      preview = await queryClient.query(spotPreviewQuery(t.orgId, previewKey(t)));
    } catch (err) {
      kits((k) => ({ ...k, previews: { ...k.previews, [t.spotId]: { playing: false, error: `what it needs did not load (${toolMessage(err)})` } } }));
      return;
    }
    const draft = get().brandKits.edits[kit.id]?.draft ?? kitDraftOf(kit);
    const themed = withDraftKit({ preview: preview.preview, kitId: kit.id, draft, assets, orientation: 'landscape' });
    if (!themed) return;
    const version = versionsById(templates).get(t.templateVersionId);
    const result = await compilePreview({ spot, draft: draftOf(spot), version, preview: themed, assets, orientation: 'landscape', live: true });
    if (seq !== link.seq || links.get(t.spotId) !== link || !result.manifest) return;
    post(link, result.manifest, seq);
  }

  function post(link: PreviewLink, manifest: ScreenManifest, seq: number) {
    const frame = link.target.frame;
    if (busy.has(frame)) {
      link.next = { manifest, seq };
      return;
    }
    frame.postMessage({ sfPreview: PREVIEW_PROTOCOL, type: 'draft', manifest }, location.origin);
    busy.set(
      frame,
      setTimeout(() => answered(frame), DRAFT_ANSWER_MS),
    );
  }

  /** `frame`'s player answered (or did not in time): the newest draft waiting for it, if any, goes now. */
  function answered(frame: Window) {
    clearTimeout(busy.get(frame));
    busy.delete(frame);
    const link = [...links.values()].find((l) => l.target.frame === frame);
    const next = link?.next;
    if (!link || !next) return;
    link.next = null;
    // A newer redraw still compiling makes the queued draft old: it posts the newest when it is done.
    if (next.seq === link.seq) post(link, next.manifest, next.seq);
  }

  const redrawAll = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const link of links.values()) void redraw(link);
    }, PREVIEW_DELAY_MS);
  };

  /** What the previews' players say. Only attached frames, on this origin, are listened to. */
  const hear = (e: MessageEvent) => {
    if (e.origin !== location.origin) return;
    const link = [...links.values()].find((l) => l.target.frame === e.source);
    const msg = link && playerMessage(e.data);
    if (!link || !msg) return;
    const spotId = link.target.spotId;
    if (msg.type === 'listening') {
      heard.add(link.target.frame);
      // A player that has just loaded has no draft in hand.
      clearTimeout(busy.get(link.target.frame));
      busy.delete(link.target.frame);
      link.next = null;
      void redraw(link);
      return;
    }
    answered(link.target.frame);
    kits((k) => ({
      ...k,
      previews: { ...k.previews, [spotId]: msg.type === 'playing' ? { playing: true, error: null } : { playing: false, error: msg.message } },
    }));
  };

  /** Runs one kit action for `kitId`'s page or row, unless one is running, marking it pending and showing its refusal there, then reads the kits again. */
  async function act(orgId: string, kitId: string, at: string, work: () => Promise<unknown>): Promise<boolean> {
    if (get().brandKits.pending !== null) return false;
    kits((k) => ({ ...k, pending: at, actionError: null }));
    try {
      await work();
      await queryClient.invalidateQueries({ queryKey: brandKitsQuery(orgId).queryKey, exact: true });
      kits((k) => ({ ...k, pending: null }));
      return true;
    } catch (err) {
      kits((k) => ({ ...k, pending: null, actionError: { kitId, text: toolMessage(err) } }));
      return false;
    }
  }

  return {
    brandKits: initial,

    editKit(kit, change) {
      // A new draft builds on the kit as the page holds it now; a later read of the kits does not move it.
      edit(kit.id, (e) => (e.draft ? { ...e, draft: change(e.draft) } : { ...e, draft: change(kitDraftOf(kit)), version: kit.version }));
      redrawAll();
    },

    fixKitPair(kit, fg, bg) {
      const draft = get().brandKits.edits[kit.id]?.draft ?? kitDraftOf(kit);
      const value = fg === 'onPrimary' || fg === 'onAccent' ? null : pairFix(shownColors(draft, kit.colors), fg, bg).hex;
      get().editKit(kit, (d) => ({ ...d, colors: { ...d.colors, [fg]: value } }));
    },

    discardKitDraft(kitId) {
      edit(kitId, (e) => ({ ...e, draft: null, version: null, error: null, stale: false }));
      redrawAll();
    },

    async saveKit(orgId, kit) {
      const { draft, version } = get().brandKits.edits[kit.id] ?? NO_EDIT;
      if (!draft || version === null) return;
      edit(kit.id, (e) => ({ ...e, saving: true, error: null }));
      try {
        const saved = brandKitVersionOf(await callTool('update_brand_kit', updateInput(kit.id, draft, version)));
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: brandKitsQuery(orgId).queryKey, exact: true }),
          // The spot editor's stage wears saved kits.
          queryClient.invalidateQueries({ queryKey: ['org', orgId, 'spotPreview'] }),
        ]);
        // A draft edited while it saved builds on the version just saved.
        edit(kit.id, (e) =>
          e.draft === draft
            ? { ...e, saving: false, savedAt: Date.now(), draft: null, version: null }
            : { ...e, saving: false, savedAt: Date.now(), version: saved },
        );
      } catch (err) {
        edit(kit.id, (e) =>
          isStale(err)
            ? { ...e, saving: false, stale: true, error: 'This kit changed since you opened it.' }
            : { ...e, saving: false, error: toolMessage(err) },
        );
      }
    },

    async reloadKit(orgId, kitId) {
      edit(kitId, (e) => ({ ...e, draft: null, version: null, error: null, stale: false }));
      await queryClient.invalidateQueries({ queryKey: brandKitsQuery(orgId).queryKey, exact: true });
      redrawAll();
    },

    pickLogo: (logoFor) => kits((k) => ({ ...k, logoFor })),

    openNewKit: (open) => kits((k) => ({ ...k, newKit: { ...newKit(), open } })),
    nameNewKit: (name) => kits((k) => ({ ...k, newKit: { ...k.newKit, name, error: null } })),

    async createKit(orgId) {
      const key = get().brandKits.newKit.key ?? crypto.randomUUID();
      kits((k) => ({ ...k, newKit: { ...k.newKit, key, pending: true, error: null } }));
      try {
        const out = await callTool('create_brand_kit', { name: get().brandKits.newKit.name.trim(), colors: NEW_KIT_COLORS, idempotencyKey: key });
        await queryClient.invalidateQueries({ queryKey: brandKitsQuery(orgId).queryKey, exact: true });
        await router.navigate({ to: '/settings/brand-kits/$kitId', params: { kitId: brandKitIdOf(out) } });
        kits((k) => ({ ...k, newKit: newKit() }));
      } catch (err) {
        kits((k) => ({ ...k, newKit: { ...k.newKit, pending: false, error: toolMessage(err) } }));
      }
    },

    async duplicateKit(orgId, kit) {
      const of = `${kit.id}:${kit.version}`;
      const key = duplicateKeys.get(of) ?? crypto.randomUUID();
      duplicateKeys.set(of, key);
      let kitId: string | undefined;
      const done = await act(orgId, kit.id, `duplicate:${kit.id}`, async () => {
        kitId = brandKitIdOf(await callTool('create_brand_kit', duplicateInput(kit, key)));
      });
      if (!done || !kitId) return;
      duplicateKeys.delete(of);
      await router.navigate({ to: '/settings/brand-kits/$kitId', params: { kitId } });
    },

    async makeDefaultKit(orgId, brandKitId) {
      await act(orgId, brandKitId, `default:${brandKitId}`, () => callTool('set_default_brand_kit', { brandKitId }));
    },

    async assignKit(orgId, kit, chosen, target) {
      await act(orgId, kit.id, `assign:${'groupId' in target ? target.groupId : target.screenId}`, () =>
        callTool('assign_brand_kit', { brandKitId: chosen ? kit.id : null, ...target }),
      );
    },

    attachKitPreview(spotId, target) {
      // Called from a ref callback, so only in the browser; the listener is added once.
      if (target && !hearing) {
        window.addEventListener('message', hear);
        hearing = true;
      }
      if (!target) {
        links.delete(spotId);
        return;
      }
      const was = links.get(spotId)?.target;
      if (was?.frame === target.frame && was.kitId === target.kitId) return;
      const link: PreviewLink = { target, seq: 0, next: null };
      links.set(spotId, link);
      kits((k) => ({ ...k, previews: { ...k.previews, [spotId]: { playing: false, error: null } } }));
      // A frame already listening (the same player, now for another kit) is posted its spot at once.
      void redraw(link);
    },

    measureKitPreview: (previewWidth) => kits((k) => (k.previewWidth === previewWidth ? k : { ...k, previewWidth })),
  };
};

/** The preview input a kit preview reads: landscape, its spot's template, this kit (its fonts' and logo's files). */
export const previewKey = (t: Pick<KitPreviewTarget, 'kitId' | 'templateVersionId'>) =>
  ({ orientation: 'landscape', templateVersionId: t.templateVersionId, brandKitId: t.kitId }) as const;
