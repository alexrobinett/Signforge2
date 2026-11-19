/**
 * The brand kit pages (canvas boards SettingsBrandKits and Idea 11): the kit being edited, its
 * save, the kit actions (new, duplicate, default, assign), and the previews, the org's own spots
 * on the real player, each in an iframe fed through the preview channel (M3-36).
 *
 * An edit changes the draft here; 40 ms later each preview's spot is compiled in the browser with
 * the draft kit laid over its preview input (`withDraftKit`) and posted to its player, so a colour
 * re-themes the spots without a round trip. Kits have no drafts on the server: Save sends the whole
 * draft to `update_brand_kit` with the version it was read at, and screens get it at their next
 * publish. Kit and assignment changes invalidate the kit list, whose `reach` they change.
 */
import { DEFAULT_BRAND_COLORS } from '@signforge/compiler';
import { PREVIEW_PROTOCOL, type BrandColor } from '@signforge/contract';
import { draftColors, duplicateInput, kitDraftOf, pairFix, updateInput, withDraftKit, type BrandKitView, type KitDraft } from '~/lib/brand-kits';
import { playerMessage } from '~/lib/preview';
import { compilePreview, draftOf, versionsById } from '~/lib/spots';
import { brandKitIdOf, callTool, isStale, toolMessage } from '~/lib/tools';
import { assetsQuery, brandKitsQuery, spotPreviewQuery, spotsQuery, templatesQuery } from '~/queries/spots';
import type { SliceCreator } from './store';

const PREVIEW_DELAY_MS = 40;

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

interface BrandKitsState {
  /** The kit the draft belongs to; another kit's page starts from its own saved values. */
  kitId: string | null;
  draft: KitDraft | null;
  saving: boolean;
  savedAt: number | null;
  error: string | null;
  /** The last save was refused because someone else changed the kit: the editor offers a reload. */
  stale: boolean;
  /** Which logo's picker is open. */
  logoFor: 'dark' | 'light' | null;
  /** The kit action running (`default`, `duplicate`, `assign:<id>`), or null. */
  pending: string | null;
  newKit: { open: boolean; name: string; pending: boolean; error: string | null; key: string | null };
  /** What each preview's player last said, by spot id. */
  previews: Record<string, { playing: boolean; error: string | null }>;
  /** The width each preview has on the page, for scaling the screen to fit; null until measured. */
  previewWidth: number | null;
}

export interface BrandKitsSlice {
  brandKits: BrandKitsState;
  /** Changes the draft of `kit`, starting from its saved values if another kit was open. */
  editKit: (kit: BrandKitView, change: (d: KitDraft) => KitDraft) => void;
  /** Gives the foreground of a failing pair its fix: a derived on-colour, or text moved until it reads. */
  fixKitPair: (kit: BrandKitView, fg: BrandColor, bg: BrandColor) => void;
  discardKitDraft: () => void;
  saveKit: (orgId: string, kit: BrandKitView) => Promise<void>;
  /** After a refused save: reads the kits again and drops the draft. */
  reloadKit: (orgId: string) => Promise<void>;
  pickLogo: (which: 'dark' | 'light' | null) => void;
  openNewKit: (open: boolean) => void;
  nameNewKit: (name: string) => void;
  /** Creates a kit with the no-kit palette and opens it. */
  createKit: (orgId: string) => Promise<void>;
  duplicateKit: (orgId: string, kit: BrandKitView) => Promise<void>;
  makeDefaultKit: (orgId: string, kitId: string) => Promise<void>;
  /** Gives a group or a screen this kit, or with null takes its choice away. */
  assignKit: (orgId: string, kitId: string | null, target: { groupId: string } | { screenId: string }) => Promise<void>;
  /** A preview's iframe and what it plays; null when it unmounts. */
  attachKitPreview: (spotId: string, target: KitPreviewTarget | null) => void;
  measureKitPreview: (width: number) => void;
}

const newKit = () => ({ open: false, name: '', pending: false, error: null, key: null });

const initial: BrandKitsState = {
  kitId: null,
  draft: null,
  saving: false,
  savedAt: null,
  error: null,
  stale: false,
  logoFor: null,
  pending: null,
  newKit: newKit(),
  previews: {},
  previewWidth: null,
};

/** One preview's player, and whether it has said it is listening. Outside state: not rendered. */
interface PreviewLink {
  target: KitPreviewTarget;
  listening: boolean;
  /** Counts redraws, so a slow compile never posts over a newer one. */
  seq: number;
}

export const createBrandKitsSlice: SliceCreator<BrandKitsSlice> = (set, get, { router, queryClient }) => {
  const kits = (change: (k: BrandKitsState) => BrandKitsState) => set((s) => ({ brandKits: change(s.brandKits) }));
  const links = new Map<string, PreviewLink>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hearing = false;

  async function redraw(link: PreviewLink) {
    const t = link.target;
    if (!link.listening) return;
    const seq = ++link.seq;
    const kit = queryClient.getQueryData(brandKitsQuery(t.orgId).queryKey)?.brandKits.find((k) => k.id === t.kitId);
    const spot = queryClient.getQueryData(spotsQuery(t.orgId).queryKey)?.spots.find((x) => x.id === t.spotId);
    const preview = queryClient.getQueryData(spotPreviewQuery(t.orgId, previewKey(t)).queryKey);
    const templates = queryClient.getQueryData(templatesQuery(t.orgId).queryKey)?.templates;
    const assets = queryClient.getQueryData(assetsQuery(t.orgId).queryKey)?.assets;
    if (!kit || !spot || !preview || !templates || !assets) return;
    const e = get().brandKits;
    const draft = e.kitId === kit.id && e.draft ? e.draft : kitDraftOf(kit);
    const themed = withDraftKit({ preview: preview.preview, kitId: kit.id, draft, assets, orientation: 'landscape' });
    if (!themed) return;
    const version = versionsById(templates).get(t.templateVersionId);
    const result = await compilePreview({ spot, draft: draftOf(spot), version, preview: themed, assets, orientation: 'landscape' });
    if (seq !== link.seq || links.get(t.spotId) !== link || !result.manifest) return;
    t.frame.postMessage({ sfPreview: PREVIEW_PROTOCOL, type: 'draft', manifest: result.manifest }, location.origin);
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
      link.listening = true;
      void redraw(link);
    } else
      kits((k) => ({
        ...k,
        previews: { ...k.previews, [spotId]: msg.type === 'playing' ? { playing: true, error: null } : { playing: false, error: msg.message } },
      }));
  };

  /** Runs one kit action, marking it pending and showing its refusal, then reads the kits again. */
  async function act(orgId: string, at: string, work: () => Promise<unknown>) {
    kits((k) => ({ ...k, pending: at, error: null }));
    try {
      await work();
      await queryClient.invalidateQueries({ queryKey: brandKitsQuery(orgId).queryKey, exact: true });
      kits((k) => ({ ...k, pending: null }));
    } catch (err) {
      kits((k) => ({ ...k, pending: null, error: toolMessage(err) }));
    }
  }

  return {
    brandKits: initial,

    editKit(kit, change) {
      kits((k) => {
        const fresh = k.kitId !== kit.id || !k.draft;
        const base = fresh ? { ...initial, newKit: k.newKit, previews: k.previews, previewWidth: k.previewWidth, kitId: kit.id } : k;
        return { ...base, draft: change(fresh ? kitDraftOf(kit) : (k.draft ?? kitDraftOf(kit))) };
      });
      redrawAll();
    },

    fixKitPair(kit, fg, bg) {
      const e = get().brandKits;
      const draft = e.kitId === kit.id && e.draft ? e.draft : kitDraftOf(kit);
      const colors = draftColors(draft);
      if (!colors) return;
      const value = fg === 'onPrimary' || fg === 'onAccent' ? null : pairFix(colors, fg, bg).hex;
      get().editKit(kit, (d) => ({ ...d, colors: { ...d.colors, [fg]: value } }));
    },

    discardKitDraft() {
      kits((k) => ({ ...k, draft: null, error: null, stale: false }));
      redrawAll();
    },

    async saveKit(orgId, kit) {
      const { draft, kitId } = get().brandKits;
      if (!draft || kitId !== kit.id) return;
      kits((k) => ({ ...k, saving: true, error: null }));
      try {
        await callTool('update_brand_kit', updateInput(kit, draft));
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: brandKitsQuery(orgId).queryKey, exact: true }),
          // The spot editor's stage wears saved kits.
          queryClient.invalidateQueries({ queryKey: ['org', orgId, 'spotPreview'] }),
        ]);
        kits((k) => ({ ...k, saving: false, savedAt: Date.now(), draft: k.draft === draft ? null : k.draft }));
      } catch (err) {
        kits((k) =>
          isStale(err)
            ? { ...k, saving: false, stale: true, error: 'This kit changed since you opened it.' }
            : { ...k, saving: false, error: toolMessage(err) },
        );
      }
    },

    async reloadKit(orgId) {
      kits((k) => ({ ...k, draft: null, error: null, stale: false }));
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
      let kitId: string | undefined;
      await act(orgId, `duplicate:${kit.id}`, async () => {
        kitId = brandKitIdOf(await callTool('create_brand_kit', duplicateInput(kit, crypto.randomUUID())));
      });
      if (kitId) await router.navigate({ to: '/settings/brand-kits/$kitId', params: { kitId } });
    },

    makeDefaultKit: (orgId, brandKitId) => act(orgId, 'default', () => callTool('set_default_brand_kit', { brandKitId })),

    assignKit: (orgId, brandKitId, target) =>
      act(orgId, `assign:${'groupId' in target ? target.groupId : target.screenId}`, () => callTool('assign_brand_kit', { brandKitId, ...target })),

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
      if (links.get(spotId)?.target.frame === target.frame) return;
      links.set(spotId, { target, listening: false, seq: 0 });
      kits((k) => ({ ...k, previews: { ...k.previews, [spotId]: { playing: false, error: null } } }));
    },

    measureKitPreview: (previewWidth) => kits((k) => (k.previewWidth === previewWidth ? k : { ...k, previewWidth })),
  };
};

/** The preview input a kit preview reads: landscape, its spot's template, this kit (its fonts' and logo's files). */
export const previewKey = (t: Pick<KitPreviewTarget, 'kitId' | 'templateVersionId'>) =>
  ({ orientation: 'landscape', templateVersionId: t.templateVersionId, brandKitId: t.kitId }) as const;
