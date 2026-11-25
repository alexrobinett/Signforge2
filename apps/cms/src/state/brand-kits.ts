/**
 * The brand kit pages (canvas boards SettingsBrandKits and Idea 11): the kit being edited, its
 * save, the kit actions (new, duplicate, default, assign), and the previews, the org's own spots
 * on the real player, each in an iframe fed through the preview channel (M3-36).
 *
 * An edit changes the draft here; 40 ms later each preview's spot is compiled in the browser with
 * the draft kit laid over its preview input (`withDraftKit`) and posted to its player, so a colour
 * re-themes the spots without a round trip. Kits have no drafts on the server: Save sends the whole
 * draft to `update_brand_kit` with the version it was read at, and screens get it at their next
 * publish. Each kit's edit is a versioned draft here (./versioned-draft.ts), so moving to another
 * kit loses nothing.
 * Kit and assignment changes invalidate the kit list, whose `reach` they change.
 */
import { DEFAULT_BRAND_COLORS } from '@signforge/compiler';
import { PREVIEW_PROTOCOL, type BrandColor, type ScreenManifest } from '@signforge/contract';
import { toast } from 'sonner';
import { draftColors, duplicateInput, kitDraftOf, pairFix, shownColors, updateInput, withDraftKit, type BrandKitView, type KitDraft } from '~/lib/brand-kits';
import { orgOnScreen } from '~/lib/live';
import { playerMessage } from '~/lib/preview';
import { compilePreview, draftOf, versionsById, type SpotPreview } from '~/lib/spots';
import { callTool, toolMessage } from '~/lib/tools';
import { assetsQuery, brandKitsQuery, spotPreviewQuery, spotsQuery, templatesQuery } from '~/queries/spots';
import type { SliceCreator } from './store';
import { AUTOSAVE_MS, autosave, createVersionedDrafts, realClock, shown, type Drafts } from './versioned-draft';

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

interface BrandKitsState {
  /** Each kit's edit, by kit id, until saved or discarded, and how its last save went. */
  drafts: Drafts<KitDraft>;
  /** Which logo's picker is open. */
  logoFor: 'dark' | 'light' | null;
  /**
   * The kit action running (`default:<kit>`, `duplicate:<kit>`, `assign:<group or screen>`), or
   * null. While one runs, or a kit saves or is created (`kitActionRunning`), another is ignored;
   * its controls say so with `aria-disabled`, since a disabled control loses keyboard focus.
   */
  pending: string | null;
  /** Why the last kit action failed, for the kit whose page or row it was started from. */
  actionError: { kitId: string; text: string } | null;
  newKit: { open: boolean; name: string; pending: boolean; error: string | null; key: string | null };
  /** What each preview's player last said, by spot id. */
  /** Per spot: whether its player plays the kit, what the player said went wrong, and why the draft kit is not sent (a logo still being checked). */
  previews: Record<string, { playing: boolean; error: string | null; refused: string | null }>;
  /** The width each preview has on the page, for scaling the screen to fit; null until measured. */
  previewWidth: number | null;
}

export interface BrandKitsSlice {
  brandKits: BrandKitsState;
  /**
   * Changes the kit's draft in `orgId`, starting from the kit as the Query cache holds it at this moment. A choice
   * (a font, the corners, a logo, a fix) says so in a toast with Undo, as the editors' do; `undo` puts it back.
   */
  editKit: (orgId: string, kitId: string, change: (d: KitDraft) => KitDraft, undo?: { said: string; change: (d: KitDraft) => KitDraft }) => void;
  /** Gives the foreground of a failing pair its fix: a derived on-colour, or text moved until it reads. */
  fixKitPair: (orgId: string, kitId: string, fg: BrandColor, bg: BrandColor) => void;
  /** Saves the kit's edit now: after a save that failed (no answer, a refusal), Try again. */
  retryKitSave: (kitId: string) => Promise<void>;
  /** After a refused save: reads the kits again and drops the kit's draft. */
  reloadKit: (orgId: string, kitId: string) => Promise<void>;
  pickLogo: (which: 'dark' | 'light' | null) => void;
  /** Opens or closes the New kit dialog. A create on its way goes on with it closed, and keeps its name and key. */
  openNewKit: (open: boolean) => void;
  nameNewKit: (name: string) => void;
  /** Creates a kit with the no-kit palette, and opens it if the member is still where they asked. */
  createKit: (orgId: string) => Promise<void>;
  /** Makes a copy, and opens it if the member is still where they asked. A retry after a lost answer sends the same key, so it never makes two. */
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
  drafts: {},
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

/**
 * Whether a kit action, a save or a new kit is on its way. They run one at a time: a Duplicate
 * during a save would copy the colours from before it, and two that navigate would race.
 */
export const kitActionRunning = ({ brandKits: k }: BrandKitsSlice) => k.pending !== null || k.newKit.pending || Object.values(k.drafts).some((d) => d.pending);

/** The draft the kit's page shows and edits, or null for `kit` as read (`shown`). */
const kitEditing = (k: BrandKitsState, kit: BrandKitView): KitDraft | null => shown(k.drafts[kit.id], kit.version);

export const createBrandKitsSlice: SliceCreator<BrandKitsSlice> = (set, get, { router, queryClient }) => {
  const kits = (change: (k: BrandKitsState) => BrandKitsState) => set((s) => ({ brandKits: change(s.brandKits) }));
  const drafts = createVersionedDrafts<KitDraft>({
    state: { read: () => get().brandKits.drafts, write: (change) => kits((k) => ({ ...k, drafts: change(k.drafts) })) },
    async save({ key: kitId, draft }) {
      // A kit's draft always starts from the kit, with its version (editKit): only a create has none.
      const version = (await callTool('update_brand_kit', updateInput(kitId, draft.edit, draft.version!))).brandKit.version;
      // Still saving until the page has the kit as saved, which the next edit builds on.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: brandKitsQuery(draft.orgId).queryKey, exact: true }),
        // The spot editor's stage wears saved kits.
        queryClient.invalidateQueries({ queryKey: ['org', draft.orgId, 'spotPreview'] }),
      ]);
      return { version };
    },
    // A kit the server would refuse as it is (no name, a colour not yet a colour) is marked, not sent, as an editor's is.
    invalid: ({ edit }) => !edit.name.trim() || draftColors(edit) === null,
    makeId: () => crypto.randomUUID(),
    currentOrg: () => orgOnScreen(router),
    clock: realClock,
  });
  /** The kit action or new kit on its way, if any. */
  let acting: Promise<unknown> = Promise.resolve();
  // Saved as the editors save (#366): a second after the last edit. Kit actions run one at a time (a save during
  // Duplicate would leave the copy without it): one due while an action runs waits for it, and is still waited for
  // by an org switch.
  const saveSoon = autosave(realClock, AUTOSAVE_MS, async (kitId) => {
    while (get().brandKits.pending !== null || get().brandKits.newKit.pending) await acting;
    await drafts.save(kitId);
  });
  const links = new Map<string, PreviewLink>();
  const cachedKit = (orgId: string, kitId: string) => queryClient.getQueryData(brandKitsQuery(orgId).queryKey)?.brandKits.find((k) => k.id === kitId);
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
      kits((k) => ({
        ...k,
        previews: { ...k.previews, [t.spotId]: { playing: false, error: `what it needs did not load (${toolMessage(err)})`, refused: null } },
      }));
      return;
    }
    const draft = kitEditing(get().brandKits, kit) ?? kitDraftOf(kit);
    const themed = withDraftKit({ preview: preview.preview, kitId: kit.id, draft, assets, orientation: 'landscape' });
    if (!themed) return;
    if ('problems' in themed) {
      // The player keeps the kit it last drew; the caption says why this one is not sent.
      if (seq === link.seq && links.get(t.spotId) === link)
        kits((k) => ({ ...k, previews: { ...k.previews, [t.spotId]: { playing: false, error: null, refused: themed.problems.join('; ') } } }));
      return;
    }
    const result = await compilePreview({
      spot,
      draft: draftOf(spot),
      versions: versionsById(templates),
      preview: themed.preview,
      timezone: preview.timezone,
      assets,
      orientation: 'landscape',
      live: true,
    });
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
      previews: {
        ...k.previews,
        [spotId]: msg.type === 'playing' ? { playing: true, error: null, refused: null } : { playing: false, error: msg.message, refused: null },
      },
    }));
  };

  // A create that finishes after the member has moved on (another page, another org) does not take
  // them away from what they are doing there; the new kit is on the list.
  const where = () => router.state.location.href;
  const stillAt = (from: string, orgId: string) => router.state.location.href === from && orgOnScreen(router) === orgId;

  /**
   * Runs one kit action for `kitId`'s page or row, unless one is running, marking it pending and
   * showing its refusal there, then reads the kits again. Every way out releases it.
   */
  function act(orgId: string, kitId: string, at: string, work: () => Promise<unknown>): Promise<boolean> {
    if (kitActionRunning(get())) return Promise.resolve(false);
    kits((k) => ({ ...k, pending: at, actionError: null }));
    const done = (async () => {
      try {
        await work();
        await queryClient.invalidateQueries({ queryKey: brandKitsQuery(orgId).queryKey, exact: true });
        return true;
      } catch (err) {
        kits((k) => ({ ...k, actionError: { kitId, text: toolMessage(err) } }));
        return false;
      } finally {
        kits((k) => ({ ...k, pending: null }));
      }
    })();
    acting = done;
    return done;
  }

  return {
    brandKits: initial,

    editKit(orgId, kitId, change, undo) {
      const kit = cachedKit(orgId, kitId);
      // Not read, or deleted: there is nothing to change.
      if (!kit) return;
      // Another kit's edit, still waiting out its second: it is saved now, not left behind, as an editor's is.
      for (const [id, d] of Object.entries(get().brandKits.drafts)) if (id !== kitId && d.status === 'unsaved') void drafts.save(id);
      // A new draft builds on the kit as the page holds it now; a later read of the kits does not move it.
      drafts.edit(kitId, { orgId, record: kitId, version: kit.version, edit: kitDraftOf(kit) }, change);
      redrawAll();
      saveSoon(kitId);
      if (undo) toast(undo.said, { action: { label: 'Undo', onClick: () => get().editKit(orgId, kitId, undo.change) } });
    },

    fixKitPair(orgId, kitId, fg, bg) {
      const kit = cachedKit(orgId, kitId);
      if (!kit) return;
      const draft = kitEditing(get().brandKits, kit) ?? kitDraftOf(kit);
      const value = fg === 'onPrimary' || fg === 'onAccent' ? null : pairFix(shownColors(draft, kit.colors), fg, bg).hex;
      const was = draft.colors[fg];
      get().editKit(orgId, kitId, (d) => ({ ...d, colors: { ...d.colors, [fg]: value } }), {
        said: 'Contrast fixed',
        change: (d) => ({ ...d, colors: { ...d.colors, [fg]: was } }),
      });
    },

    async retryKitSave(kitId) {
      await drafts.save(kitId);
    },

    async reloadKit(orgId, kitId) {
      drafts.drop(kitId);
      await queryClient.invalidateQueries({ queryKey: brandKitsQuery(orgId).queryKey, exact: true });
      redrawAll();
    },

    pickLogo: (logoFor) => kits((k) => ({ ...k, logoFor })),

    openNewKit: (open) => kits((k) => ({ ...k, newKit: k.newKit.pending ? { ...k.newKit, open } : { ...newKit(), open } })),
    nameNewKit: (name) => kits((k) => ({ ...k, newKit: { ...k.newKit, name, error: null } })),

    async createKit(orgId) {
      if (kitActionRunning(get())) return;
      const key = get().brandKits.newKit.key ?? crypto.randomUUID();
      kits((k) => ({ ...k, newKit: { ...k.newKit, key, pending: true, error: null } }));
      const from = where();
      acting = (async () => {
        try {
          const out = await callTool('create_brand_kit', { name: get().brandKits.newKit.name.trim(), colors: NEW_KIT_COLORS, idempotencyKey: key });
          await queryClient.invalidateQueries({ queryKey: brandKitsQuery(orgId).queryKey, exact: true });
          if (stillAt(from, orgId)) await router.navigate({ to: '/brand-kits/$kitId', params: { kitId: out.brandKit.id } });
          kits((k) => ({ ...k, newKit: newKit() }));
        } catch (err) {
          kits((k) => ({ ...k, newKit: { ...k.newKit, pending: false, error: toolMessage(err) } }));
        }
      })();
      await acting;
    },

    async duplicateKit(orgId, kit) {
      // An edit still waiting out its second is saved first, and the copy is of the kit as saved; refused, the copy is
      // not made, and the refusal is said where the kit's are.
      if (get().brandKits.drafts[kit.id]?.status === 'unsaved') {
        if ((await drafts.save(kit.id))?.status !== 'saved') return;
        kit = cachedKit(orgId, kit.id) ?? kit;
      }
      const of = `${kit.id}:${kit.version}`;
      const key = duplicateKeys.get(of) ?? crypto.randomUUID();
      duplicateKeys.set(of, key);
      let kitId: string | undefined;
      const from = where();
      const done = await act(orgId, kit.id, `duplicate:${kit.id}`, async () => {
        kitId = (await callTool('create_brand_kit', duplicateInput(kit, key))).brandKit.id;
      });
      if (!done || !kitId) return;
      duplicateKeys.delete(of);
      if (stillAt(from, orgId)) await router.navigate({ to: '/brand-kits/$kitId', params: { kitId } });
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
      kits((k) => ({ ...k, previews: { ...k.previews, [spotId]: { playing: false, error: null, refused: null } } }));
      // A frame already listening (the same player, now for another kit) is posted its spot at once.
      void redraw(link);
    },

    measureKitPreview: (previewWidth) => kits((k) => (k.previewWidth === previewWidth ? k : { ...k, previewWidth })),
  };
};

/** The preview input a kit preview reads: landscape, its spot's template, this kit (its fonts' and logo's files). */
export const previewKey = (t: Pick<KitPreviewTarget, 'kitId' | 'templateVersionId'>) =>
  ({ orientation: 'landscape', templateVersionId: t.templateVersionId, brandKitId: t.kitId }) as const;
