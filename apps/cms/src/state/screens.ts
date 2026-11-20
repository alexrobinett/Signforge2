/**
 * The Screens pages: pairing a screen, the actions on one screen (identify, restart, wake or
 * sleep, revoke), and the settings and display-hours drafts, each a versioned draft of the screen
 * (./versioned-draft.ts). The view and filters of the list are in the URL (`/screens?view=table`),
 * and screens themselves come from the route loaders.
 */
import { orgOnScreen } from '~/lib/live';
import type { DisplayHours, GroupView, ScreenView } from '~/lib/screen-types';
import { callTool, screenIdOf, toolMessage, versionOf } from '~/lib/tools';
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

interface ScreensState {
  pairing: PairingDraft;
  page: ScreenPageState;
  /** The settings editor's draft, and the display hours editor's, by screen id. */
  settingsDrafts: Drafts<SettingsDraft>;
  hoursDrafts: Drafts<DisplayHours | null>;
}

/** A command or change sent from a screen's page, with what to say when it worked. */
interface ScreenAction {
  label: string;
  tool: string;
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
  /** Saves the settings draft: name, time zone, orientation, groups and a new group, each with its own tool. */
  saveScreenSettings: (screen: ScreenView, groups: GroupView[]) => Promise<void>;
  saveDisplayHours: (screenId: string) => Promise<void>;
  /** After a refused save: reads the screen again and closes the editor, to be opened on what is there now. */
  reloadScreenEditor: () => Promise<void>;
  askToRevoke: (open: boolean) => void;
  /** Revokes every live credential of the screen. */
  revokeScreen: (screenId: string, credentialIds: string[]) => Promise<void>;
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

const initialScreens: ScreensState = { pairing: newPairing(), page: newPage(), settingsDrafts: {}, hoursDrafts: {} };

/** The draft of the editor open on the page, if one is: what its Save and its error show. */
export function editorDraft({ page, settingsDrafts, hoursDrafts }: ScreensState) {
  if (page.screenId === null) return undefined;
  return page.editing === 'settings' ? settingsDrafts[page.screenId] : page.editing === 'hours' ? hoursDrafts[page.screenId] : undefined;
}

const toggled = (ids: string[], id: string, member: boolean) => (member ? [...new Set([...ids, id])] : ids.filter((x) => x !== id));

export const createScreensSlice: SliceCreator<ScreensSlice> = (set, get, { router }) => {
  const pairing = (change: (p: PairingDraft) => PairingDraft) => set((s) => ({ screens: { ...s.screens, pairing: change(s.screens.pairing) } }));
  const page = (change: (p: ScreenPageState) => ScreenPageState) => set((s) => ({ screens: { ...s.screens, page: change(s.screens.page) } }));
  const screens = (change: (s: ScreensState) => ScreensState) => set((s) => ({ screens: change(s.screens) }));
  const common = { makeId: () => crypto.randomUUID(), currentOrg: () => orgOnScreen(router), clock: realClock };

  const settingsDrafts = createVersionedDrafts<SettingsDraft, { screen: ScreenView; groups: GroupView[] }>({
    ...common,
    state: { read: () => get().screens.settingsDrafts, write: (change) => screens((s) => ({ ...s, settingsDrafts: change(s.settingsDrafts) })) },
    async save({ key: screenId, draft: { edit: d, version, idempotencyKey }, context: { screen, groups }, moved }) {
      // Each change carries the version the last one left, so only someone else's change is refused;
      // a retry after a later step failed starts from there.
      let ifVersion = version;
      if (d.name.trim() !== screen.name) {
        ifVersion = versionOf(await callTool('rename_screen', { screenId, name: d.name.trim(), ifVersion }), 'screen');
        moved(ifVersion);
      }
      if (d.timezone !== screen.timezone || d.orientation !== screen.orientation)
        moved(versionOf(await callTool('update_screen_settings', { screenId, timezone: d.timezone, orientation: d.orientation, ifVersion }), 'screen'));
      // Membership is added or removed, never replaced, so a screen someone else put in a group stays.
      for (const g of groups) {
        const was = g.screenIds.includes(screenId);
        const is = d.groupIds.includes(g.id);
        if (was !== is) await callTool(is ? 'add_group_members' : 'remove_group_members', { groupId: g.id, screenIds: [screenId] });
      }
      if (d.newGroup.trim()) await callTool('create_group', { name: d.newGroup.trim(), screenIds: [screenId], idempotencyKey });
      await router.invalidate();
      return {};
    },
  });

  const hoursDrafts = createVersionedDrafts<DisplayHours | null>({
    ...common,
    state: { read: () => get().screens.hoursDrafts, write: (change) => screens((s) => ({ ...s, hoursDrafts: change(s.hoursDrafts) })) },
    async save({ key: screenId, draft: { edit: displayHours, version } }) {
      const saved = versionOf(await callTool('update_screen_settings', { screenId, displayHours, ifVersion: version }), 'screen');
      await router.invalidate();
      return { version: saved };
    },
  });

  /** The screen whose page the editors are on. */
  const editing = () => get().screens.page.screenId ?? '';
  const draft = (change: (d: SettingsDraft) => SettingsDraft) => settingsDrafts.update(editing(), change);

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
      try {
        const screenId = screenIdOf(
          await callTool('claim_screen', {
            code: d.code,
            name: d.name.trim(),
            timezone: d.timezone ?? defaults.timezone,
            orientation: d.orientation,
            ...(defaults.locale ? { locale: defaults.locale } : {}),
            ...(hours ? { displayHours: hours } : {}),
            idempotencyKey: key,
          }),
        );
        for (const groupId of d.groupIds) await callTool('add_group_members', { groupId, screenIds: [screenId] });
        await router.invalidate();
        await router.navigate({ to: '/screens/$screenId', params: { screenId } });
        screens((s) => ({ ...s, pairing: newPairing(), page: newPage() }));
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
      settingsDrafts.open(screen.id, {
        orgId,
        record: screen.id,
        version: screen.version,
        edit: { name: screen.name, timezone: screen.timezone, orientation: screen.orientation, groupIds, newGroup: '' },
      });
    },
    openDisplayHours(orgId, screen) {
      page((p) => ({ ...p, screenId: screen.id, editing: 'hours' }));
      hoursDrafts.open(screen.id, { orgId, record: screen.id, version: screen.version, edit: screen.displayHours });
    },
    closeScreenEditor() {
      settingsDrafts.drop(editing());
      hoursDrafts.drop(editing());
      page((p) => ({ ...p, editing: null }));
    },
    renameDraft: (name) => draft((d) => ({ ...d, name })),
    nameNewGroup: (newGroup) => draft((d) => ({ ...d, newGroup })),
    chooseDraftZone: (timezone) => draft((d) => ({ ...d, timezone })),
    chooseDraftOrientation: (orientation) => draft((d) => ({ ...d, orientation })),
    toggleDraftGroup: (groupId, member) => draft((d) => ({ ...d, groupIds: toggled(d.groupIds, groupId, member) })),
    editDraftHours: (hours) => hoursDrafts.update(editing(), () => hours),

    async saveScreenSettings(screen, groups) {
      await settingsDrafts.save(screen.id, { screen, groups });
      if (get().screens.settingsDrafts[screen.id]?.status === 'saved') get().closeScreenEditor();
    },

    async saveDisplayHours(screenId) {
      await hoursDrafts.save(screenId);
      if (get().screens.hoursDrafts[screenId]?.status === 'saved') get().closeScreenEditor();
    },

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
  };
};
