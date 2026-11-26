/**
 * Screen labels (#185): the rows the label editors hold, on a screen's page and in the pairing form, and saving them.
 * A label edit is a merge (`update_screen_labels`), never a versioned draft: it changes only the keys it names, so two
 * people labelling one screen never refuse each other. Suggestions come from `list_label_keys` (`labelKeysQuery`).
 */
import { toast } from 'sonner';
import { labelChange, labelRows, type LabelRow } from '~/lib/labels';
import { orgOnScreen } from '~/lib/live';
import type { ScreenView } from '~/lib/screen-types';
import { callTool, toolMessage } from '~/lib/tools';
import { labelKeysQuery } from '~/queries/screens';
import type { SliceCreator } from './store';

/** Which editor rows belong to: a screen's page, by its id, or the pairing form. */
export type LabelTarget = { screenId: string } | 'pairing';

const keyOf = (t: LabelTarget) => (t === 'pairing' ? 'pairing' : `screen:${t.screenId}`);

interface LabelsState {
  /** Each editor's rows, by `keyOf` its target; the pairing form's are claimed with the screen. */
  rows: Record<string, LabelRow[]>;
  /** The screen whose labels are open in its page's editor, with its save's progress. */
  editor: { screenId: string; pending: boolean; error: string | null } | null;
}

export interface LabelsSlice {
  labels: LabelsState;
  /** Opens the screen page's editor on its labels as saved. */
  editScreenLabels: (screen: ScreenView) => void;
  closeLabelEditor: () => void;
  /** Changes one row's key or value as typed. */
  typeLabel: (target: LabelTarget, index: number, row: LabelRow) => void;
  addLabelRow: (target: LabelTarget) => void;
  removeLabelRow: (target: LabelTarget, index: number) => void;
  /** Fills the pairing form's labels with another screen's: a new store's screens labelled as they are paired. */
  copyLabelsForPairing: (labels: Readonly<Record<string, string>>) => void;
  /** Empties the pairing form's labels, once its screen is paired. */
  clearPairingLabels: () => void;
  /** Saves the editor's rows as one merge into the screen's labels, and closes it. */
  saveScreenLabels: (orgId: string, screen: ScreenView) => Promise<void>;
}

const NONE: LabelRow[] = [];
/** The rows an editor holds: none until one is opened or typed in. */
export const labelRowsOf = (s: LabelsState, target: LabelTarget) => s.rows[keyOf(target)] ?? NONE;

export const createLabelsSlice: SliceCreator<LabelsSlice> = (set, get, { router, queryClient }) => {
  const labels = (change: (l: LabelsState) => LabelsState) => set((s) => ({ labels: change(s.labels) }));
  const rows = (target: LabelTarget, change: (r: LabelRow[]) => LabelRow[]) =>
    labels((l) => ({ ...l, rows: { ...l.rows, [keyOf(target)]: change(labelRowsOf(l, target)) } }));
  const editor = (change: (e: NonNullable<LabelsState['editor']>) => LabelsState['editor']) => labels((l) => ({ ...l, editor: l.editor && change(l.editor) }));

  return {
    labels: { rows: {}, editor: null },
    editScreenLabels: (screen) =>
      labels((l) => ({
        rows: { ...l.rows, [keyOf({ screenId: screen.id })]: [...labelRows(screen.labels), { key: '', value: '' }] },
        editor: { screenId: screen.id, pending: false, error: null },
      })),
    closeLabelEditor: () => labels((l) => ({ ...l, editor: null })),
    typeLabel: (target, index, row) => rows(target, (r) => r.map((x, i) => (i === index ? row : x))),
    addLabelRow: (target) => rows(target, (r) => [...r, { key: '', value: '' }]),
    removeLabelRow: (target, index) => rows(target, (r) => r.filter((_, i) => i !== index)),
    copyLabelsForPairing: (from) => rows('pairing', () => [...labelRows(from), { key: '', value: '' }]),
    clearPairingLabels: () => rows('pairing', () => []),

    async saveScreenLabels(orgId, screen) {
      const target = { screenId: screen.id };
      const change = labelChange(screen.labels, labelRowsOf(get().labels, target));
      if (!change) return get().closeLabelEditor();
      editor((e) => ({ ...e, pending: true, error: null }));
      try {
        await callTool('update_screen_labels', { screenIds: [screen.id], ...change });
        await Promise.all([router.invalidate(), queryClient.invalidateQueries({ queryKey: labelKeysQuery(orgId).queryKey })]);
        if (get().labels.editor?.screenId === screen.id) get().closeLabelEditor();
        if (orgOnScreen(router) === orgId) toast.success('Labels saved', { description: 'They take effect at the next publish.' });
      } catch (err) {
        editor((e) => (e.screenId === screen.id ? { ...e, pending: false, error: toolMessage(err) } : e));
      }
    },
  };
};
