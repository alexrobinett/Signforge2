/**
 * The Settings and Account pages: saving org settings (`update_org_settings`), members and
 * invitations, the profile and sessions (Better Auth's endpoints), and the invitation page. The
 * forms are uncontrolled and read on submit, so the only draft kept is the default display hours,
 * which the hours editor needs. Data comes from the route loaders; each action reloads them.
 */
import { toast } from 'sonner';
import { authClient, authErrorMessage } from '~/lib/auth-client';
import type { AlertChannel, AlertDelivery, AlertKind, AlertRule, Member } from '~/lib/settings';
import type { DisplayHours } from '~/lib/screen-types';
import { callTool, isStale, toolMessage } from '~/lib/tools';
import type { Role } from '~/server/shell.functions';
import type { SliceCreator } from './store';

interface SettingsState {
  /**
   * The action running (`general`, `invite`, `role:<memberId>`, ...), or null. While one runs,
   * another is ignored, and its controls say so with `aria-disabled` rather than `disabled`: a
   * control disabled while it has focus loses it to the page (#126).
   */
  pending: string | null;
  /** The role a member's running change gives them, so their select shows where it is going. */
  roleChange: { memberId: string; role: Role } | null;
  /**
   * How many times the settings were read again after a stale save. The forms are keyed by it,
   * not by the settings' version: their own save keeps what was typed while it ran.
   */
  reloads: number;
  /**
   * Why the last action failed, and which one it was, so the form it came from shows it. `stale`:
   * the settings changed since the page read them, and the form offers a reload.
   */
  error: { at: string; text: string; stale: boolean } | null;
  /** The General page's default hours as edited; null until edited (the saved value shows). */
  hours: { value: DisplayHours | null } | null;
  /** The member the remove dialog asks about. */
  removing: Member | null;
  /** The alert channel whose Remove is waiting for its confirmation. */
  removingChannel: AlertChannel['kind'] | null;
  /**
   * The webhook signing secret just set, shown until dismissed and never again: the page made it,
   * and SignForge keeps it only sealed. Not kept anywhere else.
   */
  signingSecret: string | null;
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
  /** Post alerts to Slack through an incoming-webhook URL; `ifVersion` when replacing one. True once saved, so the form can clear. */
  connectSlack: (webhookUrl: string, ifVersion?: number) => Promise<boolean>;
  /**
   * Send alerts to a webhook. A new one gets a signing secret made here, shown once; changing the
   * URL keeps the secret. True once saved, so the form can clear.
   */
  setWebhook: (webhookUrl: string, ifVersion?: number) => Promise<boolean>;
  /** A new signing secret for the webhook, shown once. */
  rotateSigningSecret: (ifVersion: number) => Promise<void>;
  dismissSigningSecret: () => void;
  /** Opens or closes a channel's removal confirmation; ignored while an action runs, as is the next one. */
  askToRemoveAlertChannel: (kind: AlertChannel['kind'] | null) => void;
  removeAlertChannel: (kind: AlertChannel['kind']) => Promise<void>;
  /** Send a test alert now; email goes to the member asking. */
  testAlertChannel: (channel: AlertDelivery['channel']) => Promise<void>;
  retryAlertDelivery: (deliveryId: string) => Promise<void>;
  /** After a stale save: reads the settings again, dropping what the form held. */
  reloadSettings: () => Promise<void>;
  /** True once every invite is sent, so the form can clear. */
  inviteMembers: (emails: string[], role: Role) => Promise<boolean>;
  resendInvitation: (email: string, role: Role) => Promise<void>;
  cancelInvitation: (invitationId: string) => Promise<void>;
  changeMemberRole: (memberId: string, role: Role) => Promise<void>;
  /** Opens or closes the remove dialog; ignored while an action runs. */
  askToRemoveMember: (member: Member | null) => void;
  removeMember: (memberId: string) => Promise<void>;
  saveProfile: (name: string) => Promise<void>;
  signOutSession: (token: string) => Promise<void>;
  signOutOtherSessions: () => Promise<void>;
  connectGithub: () => Promise<void>;
  acceptInvitation: (invitationId: string) => Promise<void>;
  declineInvitation: (invitationId: string) => Promise<void>;
}

/** Better Auth's client answers `{ error }`, and rejects only when the request did not get an answer. */
async function auth<T extends { error: { message?: string; code?: string; status?: number } | null }>(call: Promise<T>, fallback: string): Promise<T> {
  const res = await call.catch((cause: unknown) => {
    throw new Error(fallback, { cause });
  });
  if (res.error) throw new Error(authErrorMessage(res.error, fallback));
  return res;
}

/** `whsec_` and 32 random bytes in base64url: what `set_webhook_alert_channel` asks for. */
function newSigningSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `whsec_${btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')}`;
}

export const createSettingsSlice: SliceCreator<SettingsSlice> = (set, get, { router }) => {
  const patch = (change: (s: SettingsState) => SettingsState) => set((s) => ({ settings: change(s.settings) }));

  /**
   * Runs one action, unless one is running: marks it pending, says how it went, and reloads the
   * page's data. It stays pending until the page's loaders have finished (`sync`; without it the
   * router reloads in the background), so a control never shows the old value, or takes another
   * change, in between. Every way out releases it.
   */
  async function run(at: string, work: () => Promise<unknown>, done: string) {
    if (get().settings.pending !== null) return false;
    patch((s) => ({ ...s, pending: at, error: null }));
    try {
      await work();
      toast.success(done);
      await router.invalidate({ sync: true });
      return true;
    } catch (err) {
      const error = isStale(err) ? { at, text: 'This changed since you opened it.', stale: true } : { at, text: toolMessage(err), stale: false };
      patch((s) => ({ ...s, error }));
      return false;
    } finally {
      patch((s) => ({ ...s, pending: null }));
    }
  }

  return {
    settings: { pending: null, roleChange: null, reloads: 0, error: null, hours: null, removing: null, removingChannel: null, signingSecret: null },
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
      // An edit made while it saved is kept.
      if (saved) patch((s) => (s.hours === hours ? { ...s, hours: null } : s));
    },

    saveScreenDefaults: async (values, ifVersion) => void (await run('screens', () => callTool('update_org_settings', { ...values, ifVersion }), 'Saved')),
    saveAlerts: async (alerts, ifVersion) => void (await run('notifications', () => callTool('update_org_settings', { alerts, ifVersion }), 'Saved')),
    saveEditorsPublish: async (editorsPublish, ifVersion) =>
      void (await run('publishing', () => callTool('update_org_settings', { editorsPublish, ifVersion }), 'Saved')),
    connectSlack: (webhookUrl, ifVersion) =>
      run('slack', () => callTool('set_slack_alert_channel', { webhookUrl: webhookUrl.trim(), ifVersion }), 'Slack connected'),
    async setWebhook(webhookUrl, ifVersion) {
      const signingSecret = ifVersion === undefined ? newSigningSecret() : undefined;
      const saved = await run(
        'webhook',
        () => callTool('set_webhook_alert_channel', { webhookUrl: webhookUrl.trim(), signingSecret, ifVersion }),
        'Webhook saved',
      );
      if (saved && signingSecret) patch((s) => ({ ...s, signingSecret }));
      return saved;
    },
    async rotateSigningSecret(ifVersion) {
      const signingSecret = newSigningSecret();
      const saved = await run('webhook', () => callTool('set_webhook_alert_channel', { signingSecret, ifVersion }), 'New signing secret set');
      if (saved) patch((s) => ({ ...s, signingSecret }));
    },
    dismissSigningSecret: () => patch((s) => ({ ...s, signingSecret: null })),
    // Neither opens nor closes while an action runs: a removal once sent cannot be called back.
    askToRemoveAlertChannel: (kind) => patch((s) => (s.pending !== null ? s : { ...s, removingChannel: kind, error: null })),
    async removeAlertChannel(kind) {
      const removed = await run(
        `remove:${kind}`,
        () => callTool('remove_alert_channel', { channel: kind }),
        kind === 'slack' ? 'Slack removed' : 'Webhook removed',
      );
      if (removed) patch((s) => ({ ...s, removingChannel: null }));
    },
    testAlertChannel: async (channel) =>
      void (await run(`test:${channel}`, () => callTool('test_alert_channel', { channel }), 'Test sent. How it went shows under Recent deliveries.')),
    retryAlertDelivery: async (deliveryId) =>
      void (await run(`retry:${deliveryId}`, () => callTool('retry_alert_delivery', { alertDeliveryId: deliveryId }), 'Sending it again')),

    async reloadSettings() {
      await router.invalidate({ sync: true });
      patch((s) => ({ ...s, error: null, hours: null, reloads: s.reloads + 1 }));
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
    async changeMemberRole(memberId, role) {
      if (get().settings.pending !== null) return;
      const change = { memberId, role };
      patch((s) => ({ ...s, roleChange: change }));
      await run(`role:${memberId}`, () => auth(authClient.organization.updateMemberRole({ memberId, role }), 'Could not change the role.'), 'Role changed');
      // Another change may have started once this one let go.
      patch((s) => (s.roleChange === change ? { ...s, roleChange: null } : s));
    },
    askToRemoveMember: (member) => patch((s) => (s.pending !== null ? s : { ...s, removing: member, error: null })),
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
      if (get().settings.pending !== null) return;
      patch((s) => ({ ...s, pending: 'github', error: null }));
      try {
        // On success the browser leaves for GitHub and comes back to the account page.
        await auth(authClient.linkSocial({ provider: 'github', callbackURL: '/account' }), 'Could not connect GitHub.');
      } catch (err) {
        patch((s) => ({ ...s, error: { at: 'github', text: toolMessage(err), stale: false } }));
      } finally {
        // Released as the browser leaves too: a page the back button restores from its cache is not locked.
        patch((s) => ({ ...s, pending: null }));
      }
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
