/**
 * The Settings and Account pages: saving org settings (`update_org_settings`), members and
 * invitations, the profile and sessions (Better Auth's endpoints), and the invitation page. Data
 * comes from the route loaders; each action reloads them.
 *
 * The settings forms are controlled: a field shows its edit if there is one, else what the page
 * read, so a reload refreshes every field the member has not touched. Each form's edits are a
 * versioned draft of the org's settings (./versioned-draft.ts): a save sends only the edited
 * fields, with the version they were made on, a change made since is refused, never overwritten,
 * and the forms' saves run one at a time. Edits, running actions and errors belong to the org they
 * were made in.
 */
import type { AnyRouter } from '@tanstack/react-router';
import { toast } from 'sonner';
import { authClient, authErrorMessage } from '~/lib/auth-client';
import { orgOnScreen } from '~/lib/live';
import {
  aiTestProblem,
  type AiProvider,
  type AlertChannel,
  type AlertDelivery,
  type AlertKind,
  type AlertRule,
  type Member,
  type OrgSettings,
} from '~/lib/settings';
import type { ConnectScope } from '~/lib/connect';
import type { DisplayHours } from '~/lib/screen-types';
import { callTool, isStale, toolMessage } from '~/lib/tools';
import type { Role } from '~/server/shell.functions';
import type { SliceCreator } from './store';
import { createVersionedDrafts, realClock, shown, type Drafts } from './versioned-draft';

/** A page whose actions run one at a time. Account and the invitation page belong to no org. */
type SettingsPage = 'general' | 'screens' | 'notifications' | 'members' | 'ai' | 'agents' | 'account' | 'invitation';
/** Where an action runs: its page, in the org it was started in (null for Account and the invitation page). */
export interface SettingsScope {
  page: SettingsPage;
  orgId: string | null;
}
const scopeKey = ({ page, orgId }: SettingsScope) => `${orgId ?? ''}/${page}`;

/** A form whose edits are kept until saved: General, Screens & groups, the alert rules, Who publishes. */
type SettingsForm = 'general' | 'screens' | 'notifications' | 'publishing';
const FORM_PAGE: Record<SettingsForm, SettingsPage> = { general: 'general', screens: 'screens', notifications: 'notifications', publishing: 'members' };
const FORMS: SettingsForm[] = ['general', 'screens', 'notifications', 'publishing'];

/** A form's fields as edited, numbers as typed. `name` renames the org; the rest are `update_org_settings`' fields. */
export interface SettingsEdits {
  name?: string;
  /** '' for none: the browser's when pairing. */
  timezone?: string;
  /** '' for none: the player's default. */
  locale?: string;
  displayHours?: DisplayHours | null;
  auditRetentionDays?: string;
  updateFrom?: string;
  updateTo?: string;
  unreachableAfterMinutes?: string;
  /** Per alert kind, the fields of its rule changed. */
  alerts?: Partial<Record<AlertKind, Partial<AlertRule>>>;
  editorsPublish?: boolean;
}

interface SettingsState {
  /** The action running in each scope (`general`, `invite`, `role:<memberId>`, ...). Another there is ignored. */
  pending: Record<string, string>;
  /**
   * Why an action failed, by the action, so the form it came from shows it, in its org only.
   * `stale`: the settings changed since the edits were made, and the form offers a reload.
   */
  errors: Record<string, { orgId: string | null; text: string; stale: boolean }>;
  /** Each form's edits, by form: drafts of one record, the org's settings. */
  drafts: Drafts<SettingsEdits>;
  /** The role a member's running change gives them, so their select shows where it is going. */
  roleChange: { memberId: string; role: Role } | null;
  /** The member the remove dialog asks about. */
  removing: { orgId: string; member: Member } | null;
  /** The alert channel whose Remove is waiting for its confirmation. */
  removingChannel: { orgId: string; kind: AlertChannel['kind'] } | null;
  /**
   * The webhook signing secret just set, shown until dismissed and never again: the page made it,
   * and SignForge keeps it only sealed. Not kept anywhere else.
   */
  signingSecret: { orgId: string; secret: string } | null;
  /** The models the org's key may use, from its last test: what the model choices offer. Not kept anywhere else. */
  aiModels: { orgId: string; models: string[] } | null;
  /** The org whose model key's Remove is waiting for its confirmation. */
  removingAiKey: string | null;
  /** The scopes an agent's running change gives it, so its toggles show where they are going. */
  agentScopes: { grantId: string; scopes: ConnectScope[] } | null;
  /** The agent whose Disconnect is waiting for its confirmation. */
  disconnecting: { orgId: string; grantId: string } | null;
}

/**
 * The key form, as it sends it: the provider, the key ('' to keep the saved one), and for an
 * OpenAI-compatible endpoint its address and what it supports.
 */
interface AiKeyForm {
  provider: AiProvider['provider'];
  apiKey: string;
  baseUrl: string;
  acceptsImages: boolean;
  jsonSchemaOutput: boolean;
}

/** The AI settings' model choices and daily ceiling, as the form sends them: '' for none. */
interface AiChoices {
  fastModel: string;
  capableModel: string;
  dailyTurnCeiling: string;
}

export interface SettingsSlice {
  settings: SettingsState;
  /** Edits a form's fields in `orgId`; the first edit notes the version of the settings they are made on. */
  editSettings: (orgId: string, form: SettingsForm, version: number, change: SettingsEdits) => void;
  /**
   * Saves a form's edits: only the fields edited, with the version they were made on, so a change
   * made since is refused rather than overwritten. General also renames the org (`org`).
   */
  saveSettings: (orgId: string, form: SettingsForm, settings: OrgSettings, org?: { id: string; name: string }) => Promise<void>;
  /** Post alerts to Slack through an incoming-webhook URL; `ifVersion` when replacing one. True once saved, so the form can clear. */
  connectSlack: (orgId: string, webhookUrl: string, ifVersion?: number) => Promise<boolean>;
  /**
   * Send alerts to a webhook. A new one gets a signing secret made here, shown once; changing the
   * URL keeps the secret. True once saved, so the form can clear.
   */
  setWebhook: (orgId: string, webhookUrl: string, ifVersion?: number) => Promise<boolean>;
  /** A new signing secret for the webhook, shown once. */
  rotateSigningSecret: (orgId: string, ifVersion: number) => Promise<void>;
  dismissSigningSecret: () => void;
  /**
   * Opens or closes a channel's removal confirmation. It opens only while nothing runs on the page,
   * and stays open while its removal runs: once sent it cannot be called back.
   */
  askToRemoveAlertChannel: (orgId: string, kind: AlertChannel['kind'] | null) => void;
  removeAlertChannel: (orgId: string, kind: AlertChannel['kind']) => Promise<void>;
  /** Send a test alert now; email goes to the member asking. */
  testAlertChannel: (orgId: string, channel: AlertDelivery['channel']) => Promise<void>;
  retryAlertDelivery: (orgId: string, deliveryId: string) => Promise<void>;
  /** Save the org's model key, sealed by the API and never shown again; `ifVersion` when replacing one. True once saved, so the form can clear. */
  saveAiKey: (orgId: string, key: AiKeyForm, ifVersion?: number) => Promise<boolean>;
  /** Reach the provider with the saved key: the models it offers become the choices, or the page says why not. */
  testAiProvider: (orgId: string) => Promise<void>;
  saveAiChoices: (orgId: string, provider: AiProvider['provider'], choices: AiChoices, ifVersion: number) => Promise<void>;
  /** Opens or closes the key's removal confirmation, as `askToRemoveAlertChannel` does. */
  askToRemoveAiKey: (orgId: string, open: boolean) => void;
  removeAiKey: (orgId: string) => Promise<void>;
  /** Sets an agent's scopes from its next call (`update_agent_grant_scopes`), with the version the page read. */
  setAgentScopes: (orgId: string, grantId: string, scopes: ConnectScope[], ifVersion: number) => Promise<void>;
  /** Opens or closes an agent's Disconnect confirmation, as `askToRemoveAlertChannel` does. */
  askToDisconnectAgent: (orgId: string, grantId: string | null) => void;
  /** Disconnects an agent (`revoke_agent_grant`): its next call is refused. Then back to the list. */
  disconnectAgent: (orgId: string, grantId: string) => Promise<void>;
  /** After a stale save of `at`: reads the settings again, dropping that form's edits and error. */
  reloadSettings: (orgId: string | null, at: string) => Promise<void>;
  /** After a switch: the old org's edits and confirmations go. Its running actions finish, and change nothing here. */
  forgetOrgSettings: () => void;
  /** True once every invite is sent, so the form can clear. */
  inviteMembers: (orgId: string, emails: string[], role: Role) => Promise<boolean>;
  resendInvitation: (orgId: string, email: string, role: Role) => Promise<void>;
  cancelInvitation: (orgId: string, invitationId: string) => Promise<void>;
  changeMemberRole: (orgId: string, memberId: string, role: Role) => Promise<void>;
  /** Opens the remove dialog while nothing runs on the page; closes it at any time, a removal sent going on. */
  askToRemoveMember: (orgId: string, member: Member | null) => void;
  removeMember: (orgId: string, memberId: string) => Promise<void>;
  saveProfile: (name: string) => Promise<void>;
  signOutSession: (token: string) => Promise<void>;
  signOutOtherSessions: () => Promise<void>;
  connectGithub: () => Promise<void>;
  acceptInvitation: (invitationId: string) => Promise<void>;
  declineInvitation: (invitationId: string) => Promise<void>;
}

/** The action running in `scope`, if one is: one of its own, or the save of a form on its page. */
export const runningIn = (settings: SettingsState, scope: SettingsScope): string | undefined =>
  settings.pending[scopeKey(scope)] ??
  FORMS.find((f) => FORM_PAGE[f] === scope.page && settings.drafts[f]?.orgId === scope.orgId && settings.drafts[f].pending);

const NO_EDITS: SettingsEdits = {};
/**
 * A form's edits in `orgId`, over the settings the page read at `version`: a saved form's while the
 * settings are still at the version it saved (`shown`). Another org's are never shown.
 */
export function editsIn(settings: SettingsState, form: string, orgId: string, version: number | null): SettingsEdits {
  const draft = settings.drafts[form];
  return (draft?.orgId === orgId ? shown(draft, version) : null) ?? NO_EDITS;
}

/** Whether the form saved as `at` has edits not yet saved in `orgId`. */
export const hasEdits = (settings: SettingsState, at: string, orgId: string | null) => {
  const draft = settings.drafts[at];
  return draft?.orgId === orgId && draft.status !== 'saved' && Object.keys(draft.edit).length > 0;
};

/** The error of the action `at`, if it failed in the org on screen (or belongs to none): a form's save's, else the action's. */
export function errorOf(settings: SettingsState, at: string, orgId: string | undefined) {
  const draft = settings.drafts[at];
  if (draft?.error && draft.orgId === orgId) return { orgId: draft.orgId, text: draft.error, stale: draft.stale };
  const error = settings.errors[at];
  return error && (error.orgId === null || error.orgId === orgId) ? error : undefined;
}

/** `update_org_settings`' input for the edited fields: every other field is left as it is. */
function changeOf(edits: SettingsEdits, settings: OrgSettings) {
  const { timezone, locale, displayHours, auditRetentionDays, updateFrom, updateTo, unreachableAfterMinutes, alerts, editorsPublish } = edits;
  return {
    ...(timezone !== undefined ? { timezone: timezone || null } : {}),
    ...(locale !== undefined ? { locale: locale || null } : {}),
    ...(displayHours !== undefined ? { displayHours } : {}),
    ...(auditRetentionDays !== undefined ? { auditRetentionDays: Number(auditRetentionDays) } : {}),
    ...(updateFrom !== undefined || updateTo !== undefined
      ? { updateWindow: { from: updateFrom ?? settings.updateWindow.from, to: updateTo ?? settings.updateWindow.to } }
      : {}),
    ...(unreachableAfterMinutes !== undefined ? { unreachableAfterMinutes: Number(unreachableAfterMinutes) } : {}),
    ...(alerts !== undefined ? { alerts } : {}),
    ...(editorsPublish !== undefined ? { editorsPublish } : {}),
  };
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

/** Whether `scope` is what the tab shows: an answer for an org it has left is not announced or reloaded. */
const onScreen = (router: AnyRouter, scope: SettingsScope) => scope.orgId === null || orgOnScreen(router) === scope.orgId;

export const createSettingsSlice: SliceCreator<SettingsSlice> = (set, get, { router }) => {
  const patch = (change: (s: SettingsState) => SettingsState) => set((s) => ({ settings: change(s.settings) }));
  const withoutKey = <T>(record: Record<string, T>, key: string) => Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));

  /** The forms' edits. A save stays pending until the page's loaders have finished, as `run`'s actions do. */
  const drafts = createVersionedDrafts<SettingsEdits, { settings: OrgSettings; renamed: { id: string; name: string } | undefined }>({
    state: { read: () => get().settings.drafts, write: (change) => patch((s) => ({ ...s, drafts: change(s.drafts) })) },
    async save({ draft, context: { settings, renamed }, moved }) {
      const { name, ...fields } = draft.edit;
      if (name !== undefined && !name.trim()) throw new Error('The organization needs a name.');
      const change = changeOf(fields, settings);
      // The versioned write first: a stale save changes nothing, the name included.
      if (Object.keys(change).length) moved((await callTool('update_org_settings', { ...change, ifVersion: draft.version })).settings.version);
      if (name !== undefined && renamed && name.trim() !== renamed.name)
        await auth(authClient.organization.update({ organizationId: renamed.id, data: { name: name.trim() } }), 'Could not rename the organization.');
      if (orgOnScreen(router) === draft.orgId) {
        toast.success('Saved');
        await router.invalidate({ sync: true });
      }
      // The name is not under the settings' version: once renamed, the page shows the org's name as read.
      return { edit: fields };
    },
    makeId: () => crypto.randomUUID(),
    currentOrg: () => orgOnScreen(router),
    clock: realClock,
  });

  /**
   * Runs one action in `scope`, unless one is running there: marks it pending, says how it went,
   * and reloads the page's data. It stays pending until the page's loaders have finished (`sync`;
   * without it the router reloads in the background), so a control never shows the old value, or
   * takes another change, in between. Every way out releases it. Other pages, and other orgs, are
   * not held up by it.
   */
  async function run(scope: SettingsScope, at: string, work: () => Promise<unknown>, done: string) {
    const key = scopeKey(scope);
    if (runningIn(get().settings, scope) !== undefined) return false;
    patch((s) => ({ ...s, pending: { ...s.pending, [key]: at }, errors: withoutKey(s.errors, at) }));
    try {
      await work();
      if (onScreen(router, scope)) {
        toast.success(done);
        await router.invalidate({ sync: true });
      }
      return true;
    } catch (err) {
      const error = { orgId: scope.orgId, text: isStale(err) ? 'This changed since you opened it.' : toolMessage(err), stale: isStale(err) };
      patch((s) => ({ ...s, errors: { ...s.errors, [at]: error } }));
      return false;
    } finally {
      patch((s) => ({ ...s, pending: withoutKey(s.pending, key) }));
    }
  }

  const org = (page: SettingsPage, orgId: string): SettingsScope => ({ page, orgId });
  const notifications = (orgId: string) => org('notifications', orgId);
  const ai = (orgId: string) => org('ai', orgId);
  const agents = (orgId: string) => org('agents', orgId);
  const members = (orgId: string) => org('members', orgId);
  const account: SettingsScope = { page: 'account', orgId: null };
  const invitation: SettingsScope = { page: 'invitation', orgId: null };

  return {
    settings: {
      pending: {},
      errors: {},
      drafts: {},
      roleChange: null,
      removing: null,
      removingChannel: null,
      signingSecret: null,
      aiModels: null,
      removingAiKey: null,
      agentScopes: null,
      disconnecting: null,
    },

    editSettings: (orgId, form, version, change) => drafts.edit(form, { orgId, record: 'settings', version, edit: {} }, (e) => ({ ...e, ...change })),

    async saveSettings(orgId, form, settings, renamed) {
      if (!hasEdits(get().settings, form, orgId)) {
        toast('Nothing to save');
        return;
      }
      // Its page's other actions wait for it, as it waits for them. The forms' fields are each one
      // form's: a save moves every other form's draft on its version to the one it made.
      if (runningIn(get().settings, org(FORM_PAGE[form], orgId)) !== undefined) return;
      await drafts.save(form, { settings, renamed });
    },

    connectSlack: (orgId, webhookUrl, ifVersion) =>
      run(notifications(orgId), 'slack', () => callTool('set_slack_alert_channel', { webhookUrl: webhookUrl.trim(), ifVersion }), 'Slack connected'),
    async setWebhook(orgId, webhookUrl, ifVersion) {
      const secret = ifVersion === undefined ? newSigningSecret() : undefined;
      const saved = await run(
        notifications(orgId),
        'webhook',
        () => callTool('set_webhook_alert_channel', { webhookUrl: webhookUrl.trim(), signingSecret: secret, ifVersion }),
        'Webhook saved',
      );
      if (saved && secret) patch((s) => ({ ...s, signingSecret: { orgId, secret } }));
      return saved;
    },
    async rotateSigningSecret(orgId, ifVersion) {
      const secret = newSigningSecret();
      const saved = await run(
        notifications(orgId),
        'webhook',
        () => callTool('set_webhook_alert_channel', { signingSecret: secret, ifVersion }),
        'New signing secret set',
      );
      if (saved) patch((s) => ({ ...s, signingSecret: { orgId, secret } }));
    },
    dismissSigningSecret: () => patch((s) => ({ ...s, signingSecret: null })),
    askToRemoveAlertChannel: (orgId, kind) =>
      patch((s) => {
        const running = runningIn(s, notifications(orgId));
        if (kind ? running !== undefined : running === `remove:${s.removingChannel?.kind}`) return s;
        return { ...s, removingChannel: kind && { orgId, kind }, errors: withoutKey(s.errors, `remove:${kind ?? s.removingChannel?.kind}`) };
      }),
    async removeAlertChannel(orgId, kind) {
      const removed = await run(
        notifications(orgId),
        `remove:${kind}`,
        () => callTool('remove_alert_channel', { channel: kind }),
        kind === 'slack' ? 'Slack removed' : 'Webhook removed',
      );
      if (removed) patch((s) => (s.removingChannel?.orgId === orgId && s.removingChannel.kind === kind ? { ...s, removingChannel: null } : s));
    },
    testAlertChannel: async (orgId, channel) =>
      void (await run(
        notifications(orgId),
        `test:${channel}`,
        () => callTool('test_alert_channel', { channel }),
        'Test sent. How it went shows under Recent deliveries.',
      )),
    retryAlertDelivery: async (orgId, deliveryId) =>
      void (await run(
        notifications(orgId),
        `retry:${deliveryId}`,
        () => callTool('retry_alert_delivery', { alertDeliveryId: deliveryId }),
        'Sending it again',
      )),

    saveAiKey: (orgId, { provider, apiKey, baseUrl, acceptsImages, jsonSchemaOutput }, ifVersion) =>
      run(
        ai(orgId),
        'key',
        () =>
          callTool('save_ai_provider', {
            provider,
            apiKey: apiKey.trim() || undefined,
            ...(provider === 'openai-compatible' && { baseUrl: baseUrl.trim(), acceptsImages, jsonSchemaOutput }),
            ifVersion,
          }),
        apiKey.trim() ? 'Key saved. Test it to choose the models.' : 'Saved',
      ),
    testAiProvider: async (orgId) =>
      void (await run(
        ai(orgId),
        'test',
        async () => {
          const result = await callTool('test_ai_provider', {});
          if (!result.ok) {
            // A refused key lost its verified mark: the page reads the provider again before it says why.
            if (onScreen(router, ai(orgId))) await router.invalidate({ sync: true });
            throw new Error(aiTestProblem(result.problem ?? 'unreachable', result.provider.provider));
          }
          patch((s) => ({ ...s, aiModels: { orgId, models: result.models } }));
        },
        'Connected',
      )),
    saveAiChoices: async (orgId, provider, { fastModel, capableModel, dailyTurnCeiling }, ifVersion) =>
      void (await run(
        ai(orgId),
        'choices',
        () =>
          callTool('save_ai_provider', {
            provider,
            fastModel: fastModel || null,
            capableModel: capableModel || null,
            dailyTurnCeiling: dailyTurnCeiling.trim() ? Number(dailyTurnCeiling) : null,
            ifVersion,
          }),
        'Saved',
      )),
    askToRemoveAiKey: (orgId, open) =>
      patch((s) => {
        const running = runningIn(s, ai(orgId));
        if (open ? running !== undefined : running === 'remove') return s;
        return { ...s, removingAiKey: open ? orgId : null, errors: withoutKey(s.errors, 'remove') };
      }),
    async removeAiKey(orgId) {
      const removed = await run(ai(orgId), 'remove', () => callTool('remove_ai_provider', {}), 'Key removed. The agent uses the demo model.');
      if (removed) patch((s) => ({ ...s, removingAiKey: s.removingAiKey === orgId ? null : s.removingAiKey, aiModels: null }));
    },

    async setAgentScopes(orgId, grantId, scopes, ifVersion) {
      if (runningIn(get().settings, agents(orgId)) !== undefined) return;
      const change = { grantId, scopes };
      patch((s) => ({ ...s, agentScopes: change }));
      await run(agents(orgId), `scopes:${grantId}`, () => callTool('update_agent_grant_scopes', { grantId, scopes, ifVersion }), 'Applies from its next call');
      // Another change may have started once this one let go.
      patch((s) => (s.agentScopes === change ? { ...s, agentScopes: null } : s));
    },
    askToDisconnectAgent: (orgId, grantId) =>
      patch((s) => {
        const running = runningIn(s, agents(orgId));
        if (grantId ? running !== undefined : running?.startsWith('disconnect:')) return s;
        return { ...s, disconnecting: grantId ? { orgId, grantId } : null, errors: grantId ? withoutKey(s.errors, `disconnect:${grantId}`) : s.errors };
      }),
    async disconnectAgent(orgId, grantId) {
      const done = await run(agents(orgId), `disconnect:${grantId}`, () => callTool('revoke_agent_grant', { grantId }), 'Disconnected');
      if (!done) return;
      patch((s) => (s.disconnecting?.grantId === grantId ? { ...s, disconnecting: null } : s));
      if (orgOnScreen(router) === orgId) await router.navigate({ to: '/settings/api' });
    },

    async reloadSettings(orgId, at) {
      await router.invalidate({ sync: true });
      // Only the refused form's edits go: another page's are kept, and its own save says if they conflict.
      if (get().settings.drafts[at]?.orgId === orgId) drafts.drop(at);
      patch((s) => ({ ...s, errors: withoutKey(s.errors, at) }));
      toast('Reloaded. Make your change again on what is there now.');
    },
    forgetOrgSettings() {
      drafts.forget();
      patch((s) => ({ ...s, removing: null, removingChannel: null, signingSecret: null, aiModels: null, removingAiKey: null, disconnecting: null }));
    },

    inviteMembers(orgId, emails, role) {
      return run(
        members(orgId),
        'invite',
        async () => {
          if (!emails.length) throw new Error('Enter at least one email address.');
          for (const email of emails) await auth(authClient.organization.inviteMember({ email, role }), `Could not invite ${email}.`);
        },
        emails.length === 1 ? 'Invite sent' : `${emails.length} invites sent`,
      );
    },
    resendInvitation: async (orgId, email, role) =>
      void (await run(
        members(orgId),
        `resend:${email}`,
        () => auth(authClient.organization.inviteMember({ email, role, resend: true }), 'Could not resend it.'),
        'Invite sent again',
      )),
    cancelInvitation: async (orgId, invitationId) =>
      void (await run(
        members(orgId),
        `cancel:${invitationId}`,
        () => auth(authClient.organization.cancelInvitation({ invitationId }), 'Could not revoke it.'),
        'Invite revoked',
      )),
    async changeMemberRole(orgId, memberId, role) {
      if (runningIn(get().settings, members(orgId)) !== undefined) return;
      const change = { memberId, role };
      patch((s) => ({ ...s, roleChange: change }));
      await run(
        members(orgId),
        `role:${memberId}`,
        () => auth(authClient.organization.updateMemberRole({ memberId, role }), 'Could not change the role.'),
        'Role changed',
      );
      // Another change may have started once this one let go.
      patch((s) => (s.roleChange === change ? { ...s, roleChange: null } : s));
    },
    askToRemoveMember: (orgId, member) =>
      patch((s) =>
        member && runningIn(s, members(orgId)) !== undefined
          ? s
          : { ...s, removing: member && { orgId, member }, errors: member ? withoutKey(s.errors, `remove:${member.id}`) : s.errors },
      ),
    async removeMember(orgId, memberId) {
      const removed = await run(
        members(orgId),
        `remove:${memberId}`,
        () => auth(authClient.organization.removeMember({ memberIdOrEmail: memberId }), 'Could not remove them.'),
        'Removed',
      );
      if (removed) patch((s) => (s.removing?.member.id === memberId ? { ...s, removing: null } : s));
    },

    saveProfile: async (name) =>
      void (await run(
        account,
        'profile',
        async () => {
          if (!name.trim()) throw new Error('Enter your name.');
          await auth(authClient.updateUser({ name: name.trim() }), 'Could not save your name.');
        },
        'Saved',
      )),
    signOutSession: async (token) =>
      void (await run(account, `session:${token}`, () => auth(authClient.revokeSession({ token }), 'Could not sign it out.'), 'Signed out')),
    signOutOtherSessions: async () =>
      void (await run(account, 'sessions', () => auth(authClient.revokeOtherSessions(), 'Could not sign them out.'), 'Signed out everywhere else')),
    async connectGithub() {
      const key = scopeKey(account);
      if (runningIn(get().settings, account) !== undefined) return;
      patch((s) => ({ ...s, pending: { ...s.pending, [key]: 'github' }, errors: withoutKey(s.errors, 'github') }));
      try {
        // On success the browser leaves for GitHub and comes back to the account page.
        await auth(authClient.linkSocial({ provider: 'github', callbackURL: '/account' }), 'Could not connect GitHub.');
      } catch (err) {
        patch((s) => ({ ...s, errors: { ...s.errors, github: { orgId: null, text: toolMessage(err), stale: false } } }));
      } finally {
        // Released as the browser leaves too: a page the back button restores from its cache is not locked.
        patch((s) => ({ ...s, pending: withoutKey(s.pending, key) }));
      }
    },

    async acceptInvitation(invitationId) {
      const joined = await run(
        invitation,
        'invitation',
        () => auth(authClient.organization.acceptInvitation({ invitationId }), 'Could not accept it.'),
        'You joined',
      );
      if (joined) await router.navigate({ to: '/' });
    },
    async declineInvitation(invitationId) {
      const declined = await run(
        invitation,
        'invitation',
        () => auth(authClient.organization.rejectInvitation({ invitationId }), 'Could not decline it.'),
        'Declined',
      );
      if (declined) await router.navigate({ to: '/' });
    },
  };
};
