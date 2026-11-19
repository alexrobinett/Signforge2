/**
 * The Settings and Account pages: saving org settings (`update_org_settings`), members and
 * invitations, the profile and sessions (Better Auth's endpoints), and the invitation page. The
 * forms are uncontrolled and read on submit, so the only draft kept is the default display hours,
 * which the hours editor needs. Data comes from the route loaders; each action reloads them.
 */
import { toast } from 'sonner';
import { authClient, authErrorMessage } from '~/lib/auth-client';
import type { AlertKind, AlertRule, Member } from '~/lib/settings';
import type { DisplayHours } from '~/lib/screen-types';
import { callTool, isStale, toolMessage } from '~/lib/tools';
import type { Role } from '~/server/shell.functions';
import type { SliceCreator } from './store';

interface SettingsState {
  /** The action running (`general`, `invite`, `role:<memberId>`, ...), or null. */
  pending: string | null;
  /**
   * Why the last action failed, and which one it was, so the form it came from shows it. `stale`:
   * the settings changed since the page read them, and the form offers a reload.
   */
  error: { at: string; text: string; stale: boolean } | null;
  /** The General page's default hours as edited; null until edited (the saved value shows). */
  hours: { value: DisplayHours | null } | null;
  /** The member the remove dialog asks about. */
  removing: Member | null;
}

export interface SettingsSlice {
  settings: SettingsState;
  editDefaultHours: (hours: DisplayHours | null) => void;
  /**
   * Saves the org's defaults for new screens and how long its audit log is kept, and renames it if the name changed. This and the two
   * below send `ifVersion`, the settings' version when the page read them, so a save cannot
   * overwrite a change made since.
   */
  saveGeneral: (
    org: { id: string; name: string },
    values: { name: string; timezone: string | null; locale: string | null; auditRetentionDays: number },
    ifVersion: number,
  ) => Promise<void>;
  saveScreenDefaults: (values: { updateWindow: { from: string; to: string }; unreachableAfterMinutes: number }, ifVersion: number) => Promise<void>;
  saveAlerts: (alerts: Record<AlertKind, AlertRule>, ifVersion: number) => Promise<void>;
  /** Whether editors publish, or only owners. */
  saveEditorsPublish: (editorsPublish: boolean, ifVersion: number) => Promise<void>;
  /** After a stale save: reads the settings again, dropping what the form held. */
  reloadSettings: () => Promise<void>;
  /** True once every invite is sent, so the form can clear. */
  inviteMembers: (emails: string[], role: Role) => Promise<boolean>;
  resendInvitation: (email: string, role: Role) => Promise<void>;
  cancelInvitation: (invitationId: string) => Promise<void>;
  changeMemberRole: (memberId: string, role: Role) => Promise<void>;
  askToRemoveMember: (member: Member | null) => void;
  removeMember: (memberId: string) => Promise<void>;
  saveProfile: (name: string) => Promise<void>;
  signOutSession: (token: string) => Promise<void>;
  signOutOtherSessions: () => Promise<void>;
  connectGithub: () => Promise<void>;
  acceptInvitation: (invitationId: string) => Promise<void>;
  declineInvitation: (invitationId: string) => Promise<void>;
}

/** Better Auth's client answers `{ error }` rather than throwing. */
async function auth<T extends { error: { message?: string; code?: string; status?: number } | null }>(call: Promise<T>, fallback: string): Promise<T> {
  const res = await call;
  if (res.error) throw new Error(authErrorMessage(res.error, fallback));
  return res;
}

export const createSettingsSlice: SliceCreator<SettingsSlice> = (set, get, { router }) => {
  const patch = (change: (s: SettingsState) => SettingsState) => set((s) => ({ settings: change(s.settings) }));

  /** Runs one action: marks it pending, says how it went, and reloads the page's data. */
  async function run(at: string, work: () => Promise<unknown>, done: string) {
    patch((s) => ({ ...s, pending: at, error: null }));
    try {
      await work();
      patch((s) => ({ ...s, pending: null }));
      toast.success(done);
      await router.invalidate();
      return true;
    } catch (err) {
      const error = isStale(err) ? { at, text: 'This changed since you opened it.', stale: true } : { at, text: toolMessage(err), stale: false };
      patch((s) => ({ ...s, pending: null, error }));
      return false;
    }
  }

  return {
    settings: { pending: null, error: null, hours: null, removing: null },
    editDefaultHours: (value) => patch((s) => ({ ...s, hours: { value } })),

    async saveGeneral(org, values, ifVersion) {
      const hours = get().settings.hours;
      const saved = await run(
        'general',
        async () => {
          const name = values.name.trim();
          if (!name) throw new Error('The organization needs a name.');
          // The versioned write first: a stale save changes nothing, the name included.
          await callTool('update_org_settings', {
            timezone: values.timezone,
            locale: values.locale,
            auditRetentionDays: values.auditRetentionDays,
            ...(hours ? { displayHours: hours.value } : {}),
            ifVersion,
          });
          if (name !== org.name) await auth(authClient.organization.update({ organizationId: org.id, data: { name } }), 'Could not rename the organization.');
        },
        'Saved',
      );
      if (saved) patch((s) => ({ ...s, hours: null }));
    },

    saveScreenDefaults: async (values, ifVersion) => void (await run('screens', () => callTool('update_org_settings', { ...values, ifVersion }), 'Saved')),
    saveAlerts: async (alerts, ifVersion) => void (await run('notifications', () => callTool('update_org_settings', { alerts, ifVersion }), 'Saved')),
    saveEditorsPublish: async (editorsPublish, ifVersion) =>
      void (await run('publishing', () => callTool('update_org_settings', { editorsPublish, ifVersion }), 'Saved')),
    async reloadSettings() {
      await router.invalidate();
      patch((s) => ({ ...s, error: null, hours: null }));
      toast('Reloaded. Make your change again on what is there now.');
    },

    inviteMembers(emails, role) {
      return run(
        'invite',
        async () => {
          if (!emails.length) throw new Error('Enter at least one email address.');
          for (const email of emails) await auth(authClient.organization.inviteMember({ email, role }), `Could not invite ${email}.`);
        },
        emails.length === 1 ? 'Invite sent' : `${emails.length} invites sent`,
      );
    },
    resendInvitation: async (email, role) =>
      void (await run(
        `resend:${email}`,
        () => auth(authClient.organization.inviteMember({ email, role, resend: true }), 'Could not resend it.'),
        'Invite sent again',
      )),
    cancelInvitation: async (invitationId) =>
      void (await run(
        `cancel:${invitationId}`,
        () => auth(authClient.organization.cancelInvitation({ invitationId }), 'Could not revoke it.'),
        'Invite revoked',
      )),
    changeMemberRole: async (memberId, role) =>
      void (await run(
        `role:${memberId}`,
        () => auth(authClient.organization.updateMemberRole({ memberId, role }), 'Could not change the role.'),
        'Role changed',
      )),
    askToRemoveMember: (member) => patch((s) => ({ ...s, removing: member, error: null })),
    async removeMember(memberId) {
      const removed = await run(
        `remove:${memberId}`,
        () => auth(authClient.organization.removeMember({ memberIdOrEmail: memberId }), 'Could not remove them.'),
        'Removed',
      );
      if (removed) patch((s) => ({ ...s, removing: null }));
    },

    saveProfile: async (name) =>
      void (await run(
        'profile',
        async () => {
          if (!name.trim()) throw new Error('Enter your name.');
          await auth(authClient.updateUser({ name: name.trim() }), 'Could not save your name.');
        },
        'Saved',
      )),
    signOutSession: async (token) =>
      void (await run(`session:${token}`, () => auth(authClient.revokeSession({ token }), 'Could not sign it out.'), 'Signed out')),
    signOutOtherSessions: async () =>
      void (await run('sessions', () => auth(authClient.revokeOtherSessions(), 'Could not sign them out.'), 'Signed out everywhere else')),
    async connectGithub() {
      patch((s) => ({ ...s, pending: 'github', error: null }));
      // On success the browser leaves for GitHub and comes back to the account page.
      const res = await authClient.linkSocial({ provider: 'github', callbackURL: '/account' });
      if (res.error)
        patch((s) => ({ ...s, pending: null, error: { at: 'github', text: authErrorMessage(res.error, 'Could not connect GitHub.'), stale: false } }));
    },

    async acceptInvitation(invitationId) {
      const joined = await run('invitation', () => auth(authClient.organization.acceptInvitation({ invitationId }), 'Could not accept it.'), 'You joined');
      if (joined) await router.navigate({ to: '/' });
    },
    async declineInvitation(invitationId) {
      const declined = await run('invitation', () => auth(authClient.organization.rejectInvitation({ invitationId }), 'Could not decline it.'), 'Declined');
      if (declined) await router.navigate({ to: '/' });
    },
  };
};
