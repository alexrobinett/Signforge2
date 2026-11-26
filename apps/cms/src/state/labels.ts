/**
 * Screen labels (#185): the rows the label editors hold, on a screen's page and in the pairing form, and saving them.
 * A label edit is a merge (`update_screen_labels`), never a versioned draft: it changes only the keys it names, so two
 * people labelling one screen never refuse each other. Suggestions come from `list_label_keys` (`labelKeysQuery`).
 */
import { foldValue } from '@signforge/compiler/selector';
import { toast } from 'sonner';
import { importPlan, readLabelCsv, type ImportMode, type LabelFile } from '~/lib/label-csv';
import { labelChange, labelRows, labelsReady, MAX_BULK_SCREENS, type LabelRow } from '~/lib/labels';
import { orgOnScreen } from '~/lib/live';
import type { ScreenView } from '~/lib/screen-types';
import { callTool, toolMessage } from '~/lib/tools';
import { labelKeysQuery, screensQuery } from '~/queries/screens';
import type { AppStore, SliceCreator, StoreDeps } from './store';

/** Which editor rows belong to: a screen's page, by its id, or the pairing form. */
export type LabelTarget = { screenId: string } | 'pairing';

const keyOf = (t: LabelTarget) => (t === 'pairing' ? 'pairing' : `screen:${t.screenId}`);

interface LabelsState {
  /** Each editor's rows, by `keyOf` its target; the pairing form's are claimed with the screen. */
  rows: Record<string, LabelRow[]>;
  /** The screen whose labels are open in its page's editor, with its save's progress. */
  editor: { screenId: string; pending: boolean; error: string | null } | null;
  /** The screen the pairing form would copy labels from, chosen but not copied until asked (review of #597). */
  copyFrom: string;
  /** The Screens page's "+ Filter" dialog, while open: the key chosen and the values ticked. Applying it puts a chip in the URL. */
  filter: { key: string; values: string[] } | null;
  /** The bulk "Labels…" dialog on the table's selection, while open: one key set to one value, or removed, on every screen. */
  bulk: BulkLabels | null;
  /** "Import labels…", while open: the file as parsed, how an empty cell is read, and the send's progress (#188). */
  import: LabelImport | null;
}

interface LabelImport {
  /** Which opening this is, as `BulkLabels.opened`. */
  opened: number;
  orgId: string;
  fileName: string | null;
  /** The file's columns and rows, parsed once when it was chosen; null until one reads. */
  file: LabelFile | null;
  mode: ImportMode;
  pending: boolean;
  error: string | null;
}

interface BulkLabels {
  /** Which opening this is: a save's reply acts only on the dialog it was sent from, not one opened since (#605). */
  opened: number;
  orgId: string;
  screenIds: string[];
  key: string;
  mode: 'set' | 'remove';
  value: string;
  pending: boolean;
  error: string | null;
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
  /** Chooses the screen the pairing form would copy labels from. */
  chooseLabelSource: (screenId: string) => void;
  /** Fills the pairing form's labels with another screen's, in place of any typed: a new store's screens labelled as they are paired. */
  copyLabelsForPairing: (labels: Readonly<Record<string, string>>) => void;
  /** Empties the pairing form's labels, once its screen is paired. */
  clearPairingLabels: () => void;
  /** Opens the "+ Filter" dialog, on `key` and its values in the URL's chip when it has one. */
  openLabelFilter: (key?: string, values?: string[]) => void;
  chooseFilterKey: (key: string) => void;
  tickFilterValue: (value: string, ticked: boolean) => void;
  closeLabelFilter: () => void;
  /** Opens the bulk "Labels…" dialog on these screens, the table's selection. */
  openBulkLabels: (orgId: string, screenIds: string[]) => void;
  chooseBulkKey: (key: string) => void;
  chooseBulkMode: (mode: 'set' | 'remove') => void;
  typeBulkValue: (value: string) => void;
  closeBulkLabels: () => void;
  /** Sets the key to the value on every screen of the selection, or removes it from each, in one `update_screen_labels`. */
  applyBulkLabels: () => Promise<void>;
  /** Opens "Import labels…" on the Screens page. */
  openLabelImport: (orgId: string) => void;
  closeLabelImport: () => void;
  chooseImportMode: (mode: ImportMode) => void;
  /** Reads a chosen file and parses it once: its rows, or why it cannot be read. */
  readLabelFile: (file: File) => Promise<void>;
  /** Sends the import, as the preview shows it for `screens`, in one `import_screen_labels`: all of it, or none. */
  applyLabelImport: (screens: readonly ScreenView[]) => Promise<void>;
  /** Saves the editor's rows as one merge into the screen's labels, and closes it. */
  saveScreenLabels: (orgId: string, screen: ScreenView) => Promise<void>;
}

const NONE: LabelRow[] = [];

/**
 * When a label change reaches screens, said once for every label edit (#185): the next publish resolves labels and
 * selectors, so nothing changes on screen until then. #187's preview will say how many screens would change.
 */
export const NEXT_PUBLISH = 'Takes effect at the next publish.';
/** The rows an editor holds: none until one is opened or typed in. */
export const labelRowsOf = (s: LabelsState, target: LabelTarget) => s.rows[keyOf(target)] ?? NONE;

/** A bulk Labels draft belongs to the visit it was opened on: back on the page with the same rows ticked, none opens (#605). */
export function connectLabels(store: AppStore, { router }: StoreDeps) {
  router.subscribe('onBeforeNavigate', ({ pathChanged }) => {
    if (!pathChanged) return;
    if (store.getState().labels.bulk) store.getState().closeBulkLabels();
    // An import's file belongs to the visit too: back on the page, its old preview is not waiting (review of #612).
    if (store.getState().labels.import) store.getState().closeLabelImport();
  });
}

export const createLabelsSlice: SliceCreator<LabelsSlice> = (set, get, { router, queryClient }) => {
  const labels = (change: (l: LabelsState) => LabelsState) => set((s) => ({ labels: change(s.labels) }));
  const rows = (target: LabelTarget, change: (r: LabelRow[]) => LabelRow[]) =>
    labels((l) => ({ ...l, rows: { ...l.rows, [keyOf(target)]: change(labelRowsOf(l, target)) } }));
  /**
   * The one way labels are sent from the Screens page, a bulk edit or an import (#188): the call, then the screens and
   * the keys read again, and the toast; the refusal's words, or null when it went.
   */
  async function sendLabels(orgId: string, send: () => Promise<unknown>, done: string): Promise<string | null> {
    try {
      await send();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: screensQuery(orgId).queryKey }),
        queryClient.invalidateQueries({ queryKey: labelKeysQuery(orgId).queryKey }),
      ]);
      if (orgOnScreen(router) === orgId) toast.success(done, { description: NEXT_PUBLISH });
      return null;
    } catch (err) {
      return toolMessage(err);
    }
  }
  const labelImport = (change: (i: LabelImport) => LabelImport) => labels((l) => ({ ...l, import: l.import && change(l.import) }));
  const bulk = (change: (b: BulkLabels) => BulkLabels) => labels((l) => ({ ...l, bulk: l.bulk && change(l.bulk) }));
  let openings = 0;
  const editor = (change: (e: NonNullable<LabelsState['editor']>) => LabelsState['editor']) => labels((l) => ({ ...l, editor: l.editor && change(l.editor) }));

  return {
    labels: { rows: {}, editor: null, copyFrom: '', filter: null, bulk: null, import: null },
    openBulkLabels: (orgId, screenIds) =>
      labels((l) => ({ ...l, bulk: { opened: ++openings, orgId, screenIds, key: '', mode: 'set', value: '', pending: false, error: null } })),
    chooseBulkKey: (key) => bulk((b) => ({ ...b, key, error: null })),
    chooseBulkMode: (mode) => bulk((b) => ({ ...b, mode, error: null })),
    typeBulkValue: (value) => bulk((b) => ({ ...b, value, error: null })),
    closeBulkLabels: () => labels((l) => ({ ...l, bulk: null })),

    async applyBulkLabels() {
      const b = get().labels.bulk;
      // Over the limit the dialog says so and offers no submit: nothing is sent.
      if (!b || b.pending || b.screenIds.length > MAX_BULK_SCREENS) return;
      const key = b.key.trim().toLowerCase();
      const value = b.value.trim();
      if (!key || (b.mode === 'set' && !value)) return bulk((x) => ({ ...x, error: b.mode === 'set' ? 'Choose a label and a value.' : 'Choose a label.' }));
      bulk((x) => ({ ...x, pending: true, error: null }));
      // Cancel does not stop the call; what it answers belongs to this dialog only, which may have closed, or another opened.
      const mine = (change: (x: BulkLabels) => BulkLabels | null) => labels((l) => ({ ...l, bulk: l.bulk?.opened === b.opened ? change(l.bulk) : l.bulk }));
      const n = `${b.screenIds.length} ${b.screenIds.length === 1 ? 'screen' : 'screens'}`;
      const error = await sendLabels(
        b.orgId,
        () => callTool('update_screen_labels', { screenIds: b.screenIds, ...(b.mode === 'set' ? { set: { [key]: value } } : { remove: [key] }) }),
        b.mode === 'set' ? `Set ${key}: ${value} on ${n}` : `Removed ${key} from ${n}`,
      );
      mine((x) => (error === null ? null : { ...x, pending: false, error }));
    },

    openLabelImport: (orgId) =>
      labels((l) => ({ ...l, import: { opened: ++openings, orgId, fileName: null, file: null, mode: 'merge', pending: false, error: null } })),
    closeLabelImport: () => labels((l) => ({ ...l, import: null })),
    chooseImportMode: (mode) => labelImport((i) => ({ ...i, mode, error: null })),
    async readLabelFile(file) {
      const text = await file.text();
      // Parsed once, here, where the file comes in: the preview and the send both read what this kept.
      const read = readLabelCsv(text);
      labelImport((i) => ({
        ...i,
        fileName: file.name,
        file: read.ok ? { columns: read.columns, rows: read.rows, rowAt: read.rowAt } : null,
        error: read.ok ? null : read.error,
      }));
    },
    async applyLabelImport(screens) {
      const i = get().labels.import;
      if (!i?.file || i.pending) return;
      const { changes, problems } = importPlan(i.file, screens, i.mode);
      if (problems.length) return labelImport((x) => ({ ...x, error: 'Fix the file and choose it again: nothing is written while it has a problem.' }));
      if (!changes.length) return labelImport((x) => ({ ...x, error: 'The file changes no screen’s labels.' }));
      if (changes.length > MAX_BULK_SCREENS)
        return labelImport((x) => ({ ...x, error: `An import changes at most ${MAX_BULK_SCREENS} screens; this file changes ${changes.length}. Split it.` }));
      labelImport((x) => ({ ...x, pending: true, error: null }));
      const n = `${changes.length} ${changes.length === 1 ? 'screen' : 'screens'}`;
      const error = await sendLabels(
        i.orgId,
        () => callTool('import_screen_labels', { screens: changes.map(({ screenId, set, remove }) => ({ screenId, set, remove })) }),
        `Labels imported on ${n}`,
      );
      // As the bulk dialog's: the reply belongs to this import only (#605).
      labels((l) => ({ ...l, import: l.import?.opened === i.opened ? (error === null ? null : { ...l.import, pending: false, error }) : l.import }));
    },
    openLabelFilter: (key = '', values = []) => labels((l) => ({ ...l, filter: { key, values } })),
    chooseFilterKey: (key) => labels((l) => ({ ...l, filter: { key, values: [] } })),
    // Values compare as selectors fold them: a chip's `North` is the list's `north`, ticked and unticked as one (review of #601).
    tickFilterValue: (value, ticked) =>
      labels((l) => {
        if (!l.filter) return l;
        const others = l.filter.values.filter((v) => foldValue(v) !== foldValue(value));
        return { ...l, filter: { ...l.filter, values: ticked ? [...others, value] : others } };
      }),
    closeLabelFilter: () => labels((l) => ({ ...l, filter: null })),
    editScreenLabels: (screen) =>
      labels((l) => ({
        ...l,
        rows: { ...l.rows, [keyOf({ screenId: screen.id })]: [...labelRows(screen.labels), { key: '', value: '' }] },
        editor: { screenId: screen.id, pending: false, error: null },
      })),
    closeLabelEditor: () => labels((l) => ({ ...l, editor: null })),
    typeLabel: (target, index, row) => rows(target, (r) => r.map((x, i) => (i === index ? row : x))),
    addLabelRow: (target) => rows(target, (r) => [...r, { key: '', value: '' }]),
    removeLabelRow: (target, index) => rows(target, (r) => r.filter((_, i) => i !== index)),
    chooseLabelSource: (copyFrom) => labels((l) => ({ ...l, copyFrom })),
    copyLabelsForPairing: (from) => {
      rows('pairing', () => [...labelRows(from), { key: '', value: '' }]);
      labels((l) => ({ ...l, copyFrom: '' }));
    },
    clearPairingLabels: () => {
      rows('pairing', () => []);
      labels((l) => ({ ...l, copyFrom: '' }));
    },

    async saveScreenLabels(orgId, screen) {
      const target = { screenId: screen.id };
      const typed = labelRowsOf(get().labels, target);
      // A row that cannot be saved as it is (a repeated key, a key with no value) is said on it; nothing is sent until it is fixed.
      if (!labelsReady(typed)) return editor((e) => ({ ...e, error: 'Fix the labels marked above first.' }));
      const change = labelChange(screen.labels, typed);
      if (!change) return get().closeLabelEditor();
      editor((e) => ({ ...e, pending: true, error: null }));
      try {
        await callTool('update_screen_labels', { screenIds: [screen.id], ...change });
        await Promise.all([router.invalidate(), queryClient.invalidateQueries({ queryKey: labelKeysQuery(orgId).queryKey })]);
        if (get().labels.editor?.screenId === screen.id) get().closeLabelEditor();
        if (orgOnScreen(router) === orgId) toast.success('Labels saved', { description: NEXT_PUBLISH });
      } catch (err) {
        editor((e) => (e.screenId === screen.id ? { ...e, pending: false, error: toolMessage(err) } : e));
      }
    },
  };
};
