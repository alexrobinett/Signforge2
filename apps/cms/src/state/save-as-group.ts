/**
 * "Save as group…" on the Screens page (#186): the page's label chips, which are a selector (`selectorOf`), saved as
 * a smart group's rule in one `save_group`; then, from "Schedule a playlist for these…", the entry dialog opened aimed
 * at it. A view with more chips than a rule may have (`MAX_TERMS`) is said before any call, in the page's words.
 */
import { MAX_TERMS } from '@signforge/compiler/selector';
import { toast } from 'sonner';
import { selectorOf, type LabelTerm } from '~/lib/label-filter';
import { orgOnScreen } from '~/lib/live';
import { callTool, toolMessage } from '~/lib/tools';
import { screensQuery } from '~/queries/screens';
import type { AppStore, SliceCreator, StoreDeps } from './store';

interface SaveAsGroup {
  /** Which opening this is: a save's reply acts only on the dialog it was sent from. */
  opened: number;
  /** `save_group`'s idempotency key, the opening's own: a retry after a lost answer makes no second group. */
  key: string;
  orgId: string;
  terms: LabelTerm[];
  /** What follows the save: nothing more, or the entry dialog aimed at the group ("Schedule a playlist for these…"). */
  then: 'done' | 'schedule';
  name: string;
  pending: boolean;
  error: string | null;
}

export interface SaveAsGroupSlice {
  saveAsGroup: SaveAsGroup | null;
  openSaveAsGroup: (orgId: string, terms: LabelTerm[], then: 'done' | 'schedule') => void;
  nameGroupFromFilters: (name: string) => void;
  closeSaveAsGroup: () => void;
  /** Cancel, Escape or a click outside: ignored while the save runs, so it is all or nothing, as the group dialogs do. */
  cancelSaveAsGroup: () => void;
  /** Saves the chips as a smart group, then does what the dialog was opened for. */
  saveFiltersAsGroup: () => Promise<void>;
}

/** Why the chips cannot be a rule as they are, before anything is sent; undefined when they can. */
export const tooManyFilters = (terms: readonly LabelTerm[]) =>
  terms.length > MAX_TERMS ? `A group's rule has at most ${MAX_TERMS} filters; this view has ${terms.length}.` : undefined;

/** The dialog belongs to the visit it was opened on: leaving the page closes it. */
export function connectSaveAsGroup(store: AppStore, { router }: StoreDeps) {
  router.subscribe('onBeforeNavigate', ({ pathChanged }) => {
    if (pathChanged && store.getState().saveAsGroup) store.getState().closeSaveAsGroup();
  });
}

export const createSaveAsGroupSlice: SliceCreator<SaveAsGroupSlice> = (set, get, { router, queryClient }) => {
  let openings = 0;
  const mine = (opened: number, change: (d: SaveAsGroup) => SaveAsGroup | null) =>
    set((s) => ({ saveAsGroup: s.saveAsGroup?.opened === opened ? change(s.saveAsGroup) : s.saveAsGroup }));
  return {
    saveAsGroup: null,
    openSaveAsGroup: (orgId, terms, then) =>
      set({ saveAsGroup: { opened: ++openings, key: crypto.randomUUID(), orgId, terms, then, name: '', pending: false, error: null } }),
    nameGroupFromFilters: (name) =>
      set((s) => ({ saveAsGroup: s.saveAsGroup && !s.saveAsGroup.pending ? { ...s.saveAsGroup, name, error: null } : s.saveAsGroup })),
    closeSaveAsGroup: () => set({ saveAsGroup: null }),
    cancelSaveAsGroup: () => set((s) => ({ saveAsGroup: s.saveAsGroup?.pending ? s.saveAsGroup : null })),
    async saveFiltersAsGroup() {
      const d = get().saveAsGroup;
      if (!d || d.pending) return;
      const name = d.name.trim();
      const problem = name ? tooManyFilters(d.terms) : 'Name the group.';
      if (problem) return mine(d.opened, (x) => ({ ...x, error: problem }));
      mine(d.opened, (x) => ({ ...x, pending: true, error: null }));
      try {
        const { group } = await callTool('save_group', { name, selector: selectorOf(d.terms), idempotencyKey: d.key });
        await queryClient.invalidateQueries({ queryKey: screensQuery(d.orgId).queryKey, exact: true });
        if (get().saveAsGroup?.opened !== d.opened) return;
        set({ saveAsGroup: null });
        if (orgOnScreen(router) !== d.orgId) return;
        if (d.then === 'schedule') get().openNewEntry(d.orgId, { target: 'group', groupId: group.id });
        else toast.success(`Saved ${group.name}`, { description: 'A smart group: screens labelled to match join it at the next publish.' });
      } catch (err) {
        mine(d.opened, (x) => ({ ...x, pending: false, error: toolMessage(err) }));
      }
    },
  };
};
