/**
 * The Screens pages: pairing a screen, the actions on one screen (identify, restart, wake or
 * sleep, revoke), and the settings and display-hours drafts. The view and filters of the list are
 * in the URL (`/screens?view=table`), and screens themselves come from the route loaders.
 */
import type { DisplayHours, GroupView, ScreenView } from '~/lib/screen-types';
import { callTool, screenIdOf, toolMessage } from '~/lib/tools';
import type { SliceCreator } from './store';

type Orientation = 'landscape' | 'portrait';

/** What a new screen gets unless the pairing form chose otherwise: the org's defaults, else the browser's zone and always on. */
export interface NewScreenDefaults {
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
}

interface ScreenPageState {
  /** The screen this state is about: a notice or an open editor belongs to one screen's page. */
  screenId: string | null;
  /** The action being sent (identify, restart, display, revoke), or null. */
  busy: string | null;
  notice: { ok: boolean; text: string } | null;
  editing: 'settings' | 'hours' | null;
  revoking: boolean;
  settings: SettingsDraft | null;
  hours: DisplayHours | null;
  saving: boolean;
  saveError: string | null;
}

interface ScreensState {
  pairing: PairingDraft;
  page: ScreenPageState;
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
  pairScreen: (groups: GroupView[], defaults: NewScreenDefaults) => Promise<void>;
  /** Sends one action for a screen and says how it went. */
  actOnScreen: (screenId: string, action: ScreenAction) => Promise<void>;
  openScreenSettings: (screen: ScreenView, groupIds: string[]) => void;
  openDisplayHours: (screen: ScreenView) => void;
  closeScreenEditor: () => void;
  renameDraft: (name: string) => void;
  chooseDraftZone: (timezone: string) => void;
  chooseDraftOrientation: (orientation: Orientation) => void;
  toggleDraftGroup: (groupId: string, member: boolean) => void;
  editDraftHours: (hours: DisplayHours | null) => void;
  /** Saves the settings draft: name, time zone, orientation and groups, each with its own tool. */
  saveScreenSettings: (screen: ScreenView, groups: GroupView[]) => Promise<void>;
  saveDisplayHours: (screenId: string) => Promise<void>;
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
  settings: null,
  hours: null,
  saving: false,
  saveError: null,
});

const initialScreens: ScreensState = { pairing: newPairing(), page: newPage() };

const toggled = (ids: string[], id: string, member: boolean) => (member ? [...new Set([...ids, id])] : ids.filter((x) => x !== id));

export const createScreensSlice: SliceCreator<ScreensSlice> = (set, get, { router }) => {
  const pairing = (change: (p: PairingDraft) => PairingDraft) => set((s) => ({ screens: { ...s.screens, pairing: change(s.screens.pairing) } }));
  const page = (change: (p: ScreenPageState) => ScreenPageState) => set((s) => ({ screens: { ...s.screens, page: change(s.screens.page) } }));
  const draft = (change: (d: SettingsDraft) => SettingsDraft) => page((p) => (p.settings ? { ...p, settings: change(p.settings) } : p));

  return {
    screens: initialScreens,
    enterPairingCode: (code) => pairing((p) => ({ ...p, code })),
    nameNewScreen: (name) => pairing((p) => ({ ...p, name })),
    chooseNewScreenZone: (timezone) => pairing((p) => ({ ...p, timezone })),
    chooseNewScreenOrientation: (orientation) => pairing((p) => ({ ...p, orientation })),
    toggleNewScreenGroup: (groupId, member) => pairing((p) => ({ ...p, groupIds: toggled(p.groupIds, groupId, member) })),
    setNewScreenHours: (hours) => pairing((p) => ({ ...p, hours })),

    async pairScreen(groups, defaults) {
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
        for (const g of groups.filter((g) => d.groupIds.includes(g.id))) {
          await callTool('set_group_members', { groupId: g.id, screenIds: [...g.screenIds, screenId] });
        }
        await router.invalidate();
        await router.navigate({ to: '/screens/$screenId', params: { screenId } });
        set((s) => ({ screens: { ...s.screens, pairing: newPairing(), page: newPage() } }));
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

    openScreenSettings: (screen, groupIds) =>
      page((p) => ({
        ...p,
        screenId: screen.id,
        editing: 'settings',
        saving: false,
        saveError: null,
        settings: { name: screen.name, timezone: screen.timezone, orientation: screen.orientation, groupIds },
      })),
    openDisplayHours: (screen) => page((p) => ({ ...p, screenId: screen.id, editing: 'hours', saving: false, saveError: null, hours: screen.displayHours })),
    closeScreenEditor: () => page((p) => ({ ...p, editing: null, settings: null, hours: null, saving: false, saveError: null })),
    renameDraft: (name) => draft((d) => ({ ...d, name })),
    chooseDraftZone: (timezone) => draft((d) => ({ ...d, timezone })),
    chooseDraftOrientation: (orientation) => draft((d) => ({ ...d, orientation })),
    toggleDraftGroup: (groupId, member) => draft((d) => ({ ...d, groupIds: toggled(d.groupIds, groupId, member) })),
    editDraftHours: (hours) => page((p) => ({ ...p, hours })),

    async saveScreenSettings(screen, groups) {
      const d = get().screens.page.settings;
      if (!d) return;
      page((p) => ({ ...p, saving: true, saveError: null }));
      try {
        if (d.name.trim() !== screen.name) await callTool('rename_screen', { screenId: screen.id, name: d.name.trim() });
        if (d.timezone !== screen.timezone || d.orientation !== screen.orientation) {
          await callTool('update_screen_settings', { screenId: screen.id, timezone: d.timezone, orientation: d.orientation });
        }
        for (const g of groups) {
          const was = g.screenIds.includes(screen.id);
          const is = d.groupIds.includes(g.id);
          if (was !== is)
            await callTool('set_group_members', { groupId: g.id, screenIds: is ? [...g.screenIds, screen.id] : g.screenIds.filter((x) => x !== screen.id) });
        }
        await router.invalidate();
        get().closeScreenEditor();
      } catch (err) {
        page((p) => ({ ...p, saving: false, saveError: toolMessage(err) }));
      }
    },

    async saveDisplayHours(screenId) {
      page((p) => ({ ...p, saving: true, saveError: null }));
      try {
        await callTool('update_screen_settings', { screenId, displayHours: get().screens.page.hours });
        await router.invalidate();
        get().closeScreenEditor();
      } catch (err) {
        page((p) => ({ ...p, saving: false, saveError: toolMessage(err) }));
      }
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
