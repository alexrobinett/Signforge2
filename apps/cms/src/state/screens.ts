/**
 * The Screens pages: pairing a screen, the actions on one screen (identify, restart, wake or
 * sleep, revoke), and the settings and display-hours drafts, each a versioned draft of the screen
 * (./versioned-draft.ts); and the table's selection, with adding it to a group or removing it from
 * one, one call each. The view and filters of the list are in the URL (`/screens?view=table`),
 * and screens themselves come from the route loaders.
 */
import type { ToolName } from '@signforge/tools/outputs';
import { toast } from 'sonner';
import { labelsOf, labelsReady } from '~/lib/labels';
import { orgOnScreen } from '~/lib/live';
import type { DisplayHours, GroupView, ScreenView } from '~/lib/screen-types';
import { callTool, toolMessage } from '~/lib/tools';
import { putGroup } from '~/queries/screens';
import { labelRowsOf } from './labels';
import type { SliceCreator } from './store';
import { createVersionedDrafts, realClock, type Drafts } from './versioned-draft';

type Orientation = 'landscape' | 'portrait';

/** What a new screen gets unless the pairing form chose otherwise: the org's defaults, else the browser's zone and always on. */
interface NewScreenDefaults {
  timezone: string;
  locale: string | null;
  hours: DisplayHours | null;
}

interface PairingDraft {
  code: string;
  name: string;
  /** Null until chosen: the form shows the browser's own zone. */
  timezone: string | null;
  orientation: Orientation;
  groupIds: string[];
  /** Undefined until chosen: the form shows the org's default (`get_org_settings`). */
  hours: DisplayHours | null | undefined;
  pending: boolean;
  error: string | null;
  /** The claim's idempotency key, made on the first try and kept for retries, so a retry cannot pair twice. */
  key: string | null;
}

interface SettingsDraft {
  name: string;
  timezone: string;
  orientation: Orientation;
  groupIds: string[];
  /** A group to make with the screen in it, with the draft's idempotency key; empty for none. */
  newGroup: string;
}

interface ScreenPageState {
  /** The screen this state is about: a notice or an open editor belongs to one screen's page. */
  screenId: string | null;
  /** The action being sent (identify, restart, display, revoke), or null. */
  busy: string | null;
  notice: { ok: boolean; text: string } | null;
  editing: 'settings' | 'hours' | null;
  revoking: boolean;
}

/** What an editor on a screen's page edits: its settings, or its display hours. Both are drafts of the screen. */
type ScreenEdit = { kind: 'settings'; settings: SettingsDraft } | { kind: 'hours'; hours: DisplayHours | null };

interface ScreensState {
  pairing: PairingDraft;
  page: ScreenPageState;
  /** The editors' drafts, by `editorKey`: one record, the screen, so their saves take turns and move each other's version. */
  drafts: Drafts<ScreenEdit>;
  /** The Screens table's ticked rows, in the org they were ticked in. */
  selection: { orgId: string | null; ids: string[] };
  /** Adding the selection to a group, or removing it from one, is on its way: another is ignored. */
  bulkPending: boolean;
  /**
   * The Screens page's search as typed, the box's own value while the URL catches up (review of #601): `writes` counts
   * the URL changes on their way. With none on the way, the URL's `q` is the box's, so a Back or a link shows its own.
   */
  search: { text: string; writes: number };
}

/** A command or change sent from a screen's page, with what to say when it worked. */
export interface ScreenAction {
  label: string;
  tool: ToolName;
  input: Record<string, unknown>;
  done: string;
}

export interface ScreensSlice {
  screens: ScreensState;
  enterPairingCode: (code: string) => void;
  nameNewScreen: (name: string) => void;
  chooseNewScreenZone: (timezone: string) => void;
  chooseNewScreenOrientation: (orientation: Orientation) => void;
  toggleNewScreenGroup: (groupId: string, member: boolean) => void;
  setNewScreenHours: (hours: DisplayHours | null) => void;
  /** Claims the code, puts the new screen in its groups, and opens its page. `defaults` fill what the form left unchosen. */
  pairScreen: (defaults: NewScreenDefaults) => Promise<void>;
  /** Sends one action for a screen and says how it went. */
  actOnScreen: (screenId: string, action: ScreenAction) => Promise<void>;
  openScreenSettings: (orgId: string, screen: ScreenView, groupIds: string[]) => void;
  openDisplayHours: (orgId: string, screen: ScreenView) => void;
  closeScreenEditor: () => void;
  renameDraft: (name: string) => void;
  nameNewGroup: (name: string) => void;
  chooseDraftZone: (timezone: string) => void;
  chooseDraftOrientation: (orientation: Orientation) => void;
  toggleDraftGroup: (groupId: string, member: boolean) => void;
  editDraftHours: (hours: DisplayHours | null) => void;
  /** Saves the settings draft: the screen's name, time zone and orientation in one change, then its groups and a new group. */
  saveScreenSettings: (screen: ScreenView, groups: GroupView[]) => Promise<void>;
  saveDisplayHours: (screen: ScreenView) => Promise<void>;
  /** After a refused save: reads the screen again and closes the editor, to be opened on what is there now. */
  reloadScreenEditor: () => Promise<void>;
  askToRevoke: (open: boolean) => void;
  /** Revokes every live credential of the screen. */
  revokeScreen: (screenId: string, credentialIds: string[]) => Promise<void>;
  /** Ticks or unticks rows of the Screens table in `orgId`: one, or all it shows. */
  selectScreens: (orgId: string, screenIds: string[], selected: boolean) => void;
  clearScreenSelection: () => void;
  /** Puts the screens in the group, in one call; a screen already in it stays. */
  addScreensToGroup: (orgId: string, group: GroupView, screenIds: string[]) => Promise<void>;
  /** Takes the screens out of the group, in one call. */
  removeScreensFromGroup: (orgId: string, group: GroupView, screenIds: string[]) => Promise<void>;
  /** The Screens page's search as typed: the box shows it at once, and the URL's `q` follows. */
  searchScreens: (text: string) => Promise<void>;
}

const newPairing = (): PairingDraft => ({
  code: '',
  name: '',
  timezone: null,
  orientation: 'landscape',
  groupIds: [],
  hours: undefined,
  pending: false,
  error: null,
  key: null,
});

const newPage = (): ScreenPageState => ({
  screenId: null,
  busy: null,
  notice: null,
  editing: null,
  revoking: false,
});

const initialScreens: ScreensState = {
  pairing: newPairing(),
  page: newPage(),
  drafts: {},
  selection: { orgId: null, ids: [] },
  bulkPending: false,
  search: { text: '', writes: 0 },
};

/** What the Screens page's search box shows: as typed while its URL writes are on their way, else the URL's `q`. */
export const searchText = (s: ScreensState, q: string | undefined) => (s.search.writes > 0 ? s.search.text : (q ?? ''));

const NONE: string[] = [];

/** The rows ticked in `orgId`: none when they were ticked in another. */
export const selectedIn = (s: ScreensState, orgId: string) => (s.selection.orgId === orgId ? s.selection.ids : NONE);

/** Where an editor's draft for a screen is kept. */
const editorKey = (editor: 'settings' | 'hours', screenId: string) => `${editor}:${screenId}`;

/** The draft of the editor open on the page, if one is: what its Save and its error show. */
export function editorDraft({ page, drafts }: ScreensState) {
  return page.screenId === null || page.editing === null ? undefined : drafts[editorKey(page.editing, page.screenId)];
}

/** The settings editor's fields for `screenId`, if it is open there. */
export function settingsDraftOf(s: ScreensState, screenId: string): SettingsDraft | null {
  const edit = s.page.screenId === screenId ? s.drafts[editorKey('settings', screenId)]?.edit : undefined;
  return edit?.kind === 'settings' ? edit.settings : null;
}

/** The display hours editor's hours for `screenId`. */
export function hoursDraftOf(s: ScreensState, screenId: string): DisplayHours | null {
  const edit = s.drafts[editorKey('hours', screenId)]?.edit;
  return edit?.kind === 'hours' ? edit.hours : null;
}

const toggled = (ids: string[], id: string, member: boolean) => (member ? [...new Set([...ids, id])] : ids.filter((x) => x !== id));

export const createScreensSlice: SliceCreator<ScreensSlice> = (set, get, { router, queryClient }) => {
  const pairing = (change: (p: PairingDraft) => PairingDraft) => set((s) => ({ screens: { ...s.screens, pairing: change(s.screens.pairing) } }));
  const page = (change: (p: ScreenPageState) => ScreenPageState) => set((s) => ({ screens: { ...s.screens, page: change(s.screens.page) } }));
  const screens = (change: (s: ScreensState) => ScreensState) => set((s) => ({ screens: change(s.screens) }));

  const drafts = createVersionedDrafts<ScreenEdit, { screen: ScreenView; groups: GroupView[] }>({
    makeId: () => crypto.randomUUID(),
    currentOrg: () => orgOnScreen(router),
    clock: realClock,
    state: { read: () => get().screens.drafts, write: (change) => screens((s) => ({ ...s, drafts: change(s.drafts) })) },
    async save({ draft: { edit, version, idempotencyKey }, context: { screen, groups }, moved }) {
      const screenId = screen.id;
      if (edit.kind === 'hours') {
        const saved = (await callTool('update_screen', { screenId, displayHours: edit.hours, ifVersion: version! })).screen.version;
        await router.invalidate();
        return { version: saved };
      }
      const d = edit.settings;
      // The screen's own fields in one change, at the version read, so only someone else's change is refused;
      // a retry after a later step failed starts from the version it left.
      const name = d.name.trim();
      const changed = {
        ...(name !== screen.name ? { name } : {}),
        ...(d.timezone !== screen.timezone ? { timezone: d.timezone } : {}),
        ...(d.orientation !== screen.orientation ? { orientation: d.orientation } : {}),
      };
      if (Object.keys(changed).length) moved((await callTool('update_screen', { screenId, ...changed, ifVersion: version! })).screen.version);
      // Membership is added or removed, never replaced, so a screen someone else put in a group stays.
      for (const g of groups) {
        const was = g.screenIds.includes(screenId);
        const is = d.groupIds.includes(g.id);
        if (was !== is) await callTool('save_group', { groupId: g.id, screenIds: [screenId], membership: is ? 'add' : 'remove' });
      }
      if (d.newGroup.trim()) await callTool('save_group', { name: d.newGroup.trim(), screenIds: [screenId], idempotencyKey });
      await router.invalidate();
      return {};
    },
  });

  /** The screen whose page the editors are on. */
  const editing = () => get().screens.page.screenId ?? '';
  const draft = (change: (d: SettingsDraft) => SettingsDraft) =>
    drafts.update(editorKey('settings', editing()), (e) => (e.kind === 'settings' ? { ...e, settings: change(e.settings) } : e));

  /** Saves an editor's draft; once saved, its editor closes, unless another has opened since. */
  async function saveEditor(editor: 'settings' | 'hours', screen: ScreenView, groups: GroupView[]) {
    const key = editorKey(editor, screen.id);
    const saved = await drafts.save(key, { screen, groups });
    if (saved?.status === 'saved' && get().screens.drafts[key]?.id === saved.id) get().closeScreenEditor();
  }

  /** One call over many screens for one group, said in a toast. */
  async function changeMembers(orgId: string, group: GroupView, screenIds: string[], add: boolean) {
    if (get().screens.bulkPending) return;
    screens((s) => ({ ...s, bulkPending: true }));
    const n = `${screenIds.length} ${screenIds.length === 1 ? 'screen' : 'screens'}`;
    try {
      const out = await callTool('save_group', { groupId: group.id, screenIds, membership: add ? 'add' : 'remove' });
      putGroup(queryClient, orgId, out.group);
      if (orgOnScreen(router) === orgId) toast.success(add ? `Added ${n} to ${group.name}` : `Removed ${n} from ${group.name}`);
    } catch (err) {
      if (orgOnScreen(router) === orgId) toast.error(add ? `Not added to ${group.name}` : `Not removed from ${group.name}`, { description: toolMessage(err) });
    } finally {
      screens((s) => ({ ...s, bulkPending: false }));
    }
  }

  return {
    screens: initialScreens,
    enterPairingCode: (code) => pairing((p) => ({ ...p, code })),
    nameNewScreen: (name) => pairing((p) => ({ ...p, name })),
    chooseNewScreenZone: (timezone) => pairing((p) => ({ ...p, timezone })),
    chooseNewScreenOrientation: (orientation) => pairing((p) => ({ ...p, orientation })),
    toggleNewScreenGroup: (groupId, member) => pairing((p) => ({ ...p, groupIds: toggled(p.groupIds, groupId, member) })),
    setNewScreenHours: (hours) => pairing((p) => ({ ...p, hours })),

    async pairScreen(defaults) {
      const key = get().screens.pairing.key ?? crypto.randomUUID();
      pairing((p) => ({ ...p, key, pending: true, error: null }));
      const d = get().screens.pairing;
      const hours = d.hours === undefined ? defaults.hours : d.hours;
      const rows = labelRowsOf(get().labels, 'pairing');
      // As the label editor saves: no row lost without a word (review of #597).
      if (!labelsReady(rows)) return pairing((p) => ({ ...p, pending: false, error: 'Fix the labels marked above first.' }));
      const labels = labelsOf(rows);
      try {
        const screenId = (
          await callTool('claim_screen', {
            code: d.code,
            name: d.name.trim(),
            timezone: d.timezone ?? defaults.timezone,
            orientation: d.orientation,
            ...(defaults.locale ? { locale: defaults.locale } : {}),
            ...(hours ? { displayHours: hours } : {}),
            ...(Object.keys(labels).length ? { labels } : {}),
            idempotencyKey: key,
          })
        ).screen.id;
        for (const groupId of d.groupIds) await callTool('save_group', { groupId, screenIds: [screenId], membership: 'add' });
        await router.invalidate();
        await router.navigate({ to: '/screens/$screenId', params: { screenId } });
        screens((s) => ({ ...s, pairing: newPairing(), page: newPage() }));
        get().clearPairingLabels();
      } catch (err) {
        pairing((p) => ({ ...p, pending: false, error: toolMessage(err) }));
      }
    },

    async actOnScreen(screenId, action) {
      page((p) => ({ ...p, screenId, busy: action.label, notice: null }));
      try {
        await callTool(action.tool, { screenId, ...action.input });
        page((p) => ({ ...p, busy: null, notice: { ok: true, text: action.done } }));
        await router.invalidate();
      } catch (err) {
        page((p) => ({ ...p, busy: null, notice: { ok: false, text: toolMessage(err) } }));
      }
    },

    openScreenSettings(orgId, screen, groupIds) {
      page((p) => ({ ...p, screenId: screen.id, editing: 'settings' }));
      drafts.open(editorKey('settings', screen.id), {
        orgId,
        record: screen.id,
        version: screen.version,
        edit: { kind: 'settings', settings: { name: screen.name, timezone: screen.timezone, orientation: screen.orientation, groupIds, newGroup: '' } },
      });
    },
    openDisplayHours(orgId, screen) {
      page((p) => ({ ...p, screenId: screen.id, editing: 'hours' }));
      drafts.open(editorKey('hours', screen.id), { orgId, record: screen.id, version: screen.version, edit: { kind: 'hours', hours: screen.displayHours } });
    },
    closeScreenEditor() {
      drafts.drop(editorKey('settings', editing()));
      drafts.drop(editorKey('hours', editing()));
      page((p) => ({ ...p, editing: null }));
    },
    renameDraft: (name) => draft((d) => ({ ...d, name })),
    nameNewGroup: (newGroup) => draft((d) => ({ ...d, newGroup })),
    chooseDraftZone: (timezone) => draft((d) => ({ ...d, timezone })),
    chooseDraftOrientation: (orientation) => draft((d) => ({ ...d, orientation })),
    toggleDraftGroup: (groupId, member) => draft((d) => ({ ...d, groupIds: toggled(d.groupIds, groupId, member) })),
    editDraftHours: (hours) => drafts.update(editorKey('hours', editing()), (e) => (e.kind === 'hours' ? { ...e, hours } : e)),

    saveScreenSettings: (screen, groups) => saveEditor('settings', screen, groups),
    saveDisplayHours: (screen) => saveEditor('hours', screen, []),

    async reloadScreenEditor() {
      await router.invalidate();
      get().closeScreenEditor();
      page((p) => ({ ...p, notice: { ok: true, text: 'Reloaded. Open it again to make your change on what is there now.' } }));
    },

    askToRevoke: (revoking) => page((p) => ({ ...p, revoking })),

    async revokeScreen(screenId, credentialIds) {
      for (const credentialId of credentialIds) {
        await get().actOnScreen(screenId, {
          label: 'revoke',
          tool: 'revoke_screen_credential',
          input: { credentialId },
          done: 'Revoked. The screen has stopped playing and shows a pairing code.',
        });
      }
    },

    selectScreens: (orgId, screenIds, selected) =>
      screens((s) => {
        const ids = selectedIn(s, orgId);
        return { ...s, selection: { orgId, ids: selected ? [...new Set([...ids, ...screenIds])] : ids.filter((id) => !screenIds.includes(id)) } };
      }),
    clearScreenSelection: () => screens((s) => ({ ...s, selection: { orgId: null, ids: [] } })),
    async searchScreens(text) {
      screens((s) => ({ ...s, search: { text, writes: s.search.writes + 1 } }));
      try {
        await router.navigate({ to: '/screens', search: (prev: Record<string, unknown>) => ({ ...prev, q: text || undefined }), replace: true });
      } finally {
        screens((s) => ({ ...s, search: { ...s.search, writes: s.search.writes - 1 } }));
      }
    },
    addScreensToGroup: (orgId, group, screenIds) => changeMembers(orgId, group, screenIds, true),
    removeScreensFromGroup: (orgId, group, screenIds) => changeMembers(orgId, group, screenIds, false),
  };
};
