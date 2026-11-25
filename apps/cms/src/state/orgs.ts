/** Switching the active organization, and the create-organization forms. */
import { createOrganization, switchOrganization } from '~/lib/orgs';
import type { SliceCreator } from './store';
import { saveWaiting } from './versioned-draft';

/**
 * Where a create-organization form sits. Each has its own draft, since both can be on screen:
 * the first-org card on the org picker, and the dialog the account menu and ⌘K open.
 */
export type CreateOrgFormId = 'picker' | 'dialog';

interface CreateOrgDraft {
  name: string;
  pending: boolean;
  error: string | null;
}

export interface OrgsState {
  /** The org being switched to, while the switch runs. */
  switchingTo: string | null;
  /** What a switch or create from the menus announces to screen readers. */
  status: string;
  /** Why the last switch from the org picker failed. */
  pickerError: string | null;
  createDialogOpen: boolean;
  drafts: Record<CreateOrgFormId, CreateOrgDraft>;
}

export interface OrgsSlice {
  orgs: OrgsState;
  /**
   * Makes `org` active, unless a switch or a create is already on its way. From the switcher or ⌘K it
   * announces progress; from the picker it shows an error only.
   */
  switchOrg: (org: { id: string; name: string }, from: 'switcher' | 'picker') => Promise<void>;
  /** Opens the create dialog, closing the phone drawer it may be opened from. */
  openCreateOrg: () => void;
  /** Closes the create dialog and drops its draft, as cancelling should. */
  closeCreateOrg: () => void;
  editOrgName: (form: CreateOrgFormId, name: string) => void;
  /** Creates the org from that form's draft, unless a switch or a create is on its way; it becomes the active org. */
  createOrg: (form: CreateOrgFormId) => Promise<void>;
}

const emptyDraft: CreateOrgDraft = { name: '', pending: false, error: null };

/**
 * Whether a switch or a create is on its way. Each ends in the tab's reload as the new org
 * (`reloadAs`), so only one runs at a time, from any menu or form: a second's reload would be
 * refused as a tab on the old org.
 */
export const changingOrg = (orgs: OrgsState) => orgs.switchingTo !== null || Object.values(orgs.drafts).some((d) => d.pending);

export const initialOrgs: OrgsState = {
  switchingTo: null,
  status: '',
  pickerError: null,
  createDialogOpen: false,
  drafts: { picker: emptyDraft, dialog: emptyDraft },
};

export const createOrgsSlice: SliceCreator<OrgsSlice> = (set, get, { router }) => {
  const draft = (form: CreateOrgFormId, change: Partial<CreateOrgDraft>) =>
    set((s) => ({ orgs: { ...s.orgs, drafts: { ...s.orgs.drafts, [form]: { ...s.orgs.drafts[form], ...change } } } }));

  return {
    orgs: initialOrgs,

    async switchOrg(org, from) {
      // The drawer's conversation, a turn on its way, and the sidebar's Publish question are this org's: none of it goes to the next.
      get().forgetAgentDrawer();
      get().cancelPublishAll();
      if (changingOrg(get().orgs)) return;
      const announce = from === 'switcher';
      set((s) => ({
        orgs: {
          ...s.orgs,
          switchingTo: org.id,
          status: announce ? `Switching to ${org.name}…` : s.orgs.status,
          pickerError: announce ? s.orgs.pickerError : null,
        },
      }));
      try {
        // An edit still waiting out its autosave delay saves only in its own org: it goes before the tab leaves it.
        await saveWaiting();
        await switchOrganization(router, org.id);
        // Edits and confirmations belong to the org they were made in.
        get().forgetOrgSettings();
        if (announce) set((s) => ({ orgs: { ...s.orgs, status: `Switched to ${org.name}.` } }));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Could not switch organization.';
        set((s) => ({ orgs: announce ? { ...s.orgs, status: message } : { ...s.orgs, pickerError: message } }));
      } finally {
        set((s) => ({ orgs: { ...s.orgs, switchingTo: null } }));
      }
    },

    openCreateOrg: () => set((s) => ({ orgs: { ...s.orgs, createDialogOpen: true }, ui: { ...s.ui, drawerOpen: false } })),
    closeCreateOrg: () => set((s) => ({ orgs: { ...s.orgs, createDialogOpen: false, drafts: { ...s.orgs.drafts, dialog: emptyDraft } } })),
    editOrgName: (form, name) => draft(form, { name }),

    async createOrg(form) {
      if (changingOrg(get().orgs)) return;
      const name = get().orgs.drafts[form].name.trim();
      if (!name) return draft(form, { error: 'Enter a name.' });
      draft(form, { pending: true, error: null });
      // Creating makes the new org active: the drawer's conversation stays with the org it was in, as on a switch.
      get().forgetAgentDrawer();
      get().cancelPublishAll();
      try {
        // As on a switch: the new org becomes the tab's.
        await saveWaiting();
        await createOrganization(router, name);
        get().forgetOrgSettings();
        draft(form, emptyDraft);
        if (form === 'dialog') set((s) => ({ orgs: { ...s.orgs, createDialogOpen: false, status: 'Organization created.' } }));
      } catch (err) {
        draft(form, { pending: false, error: err instanceof Error ? err.message : 'Could not create the organization.' });
      }
    },
  };
};
