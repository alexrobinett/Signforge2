/**
 * The Settings and Account pages' reads: org settings through the tool registry, members,
 * invitations, sessions and sign-in methods from Better Auth's endpoints, as the signed-in member.
 * Writes go from the browser (src/state/settings.ts).
 */
import { createServerFn } from '@tanstack/react-start';
import type { AlertChannel, AlertDelivery, Invitation, Member, OrgSettings, SessionRow } from '~/lib/settings';
import { callApi } from './api.server';
import type { Role } from './shell.functions';
import { inOrg, tool } from './tools.server';

async function read<T>(path: `/api/${string}`): Promise<T> {
  const res = await callApi(path);
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  // The endpoint's response: Better Auth's (better-auth 1.7.25, pinned) or the API's own /api/session.
  const body: T = await res.json();
  return body;
}

export const getOrgSettings = createServerFn({ method: 'GET' }).handler(() =>
  inOrg(async () => (await tool<{ settings: OrgSettings }>('get_org_settings', {})).settings, null),
);

/**
 * The Notifications page: the alert rules, the Slack and webhook channels, the 20 newest deliveries,
 * and members' names by user id, for who set each channel.
 */
export const getNotifications = createServerFn({ method: 'GET' }).handler(() =>
  inOrg(async () => {
    const [{ settings }, channels, { deliveries }, { members }] = await Promise.all([
      tool<{ settings: OrgSettings }>('get_org_settings', {}),
      tool<{ slack: AlertChannel | null; webhook: AlertChannel | null }>('get_alert_channels', {}),
      tool<{ deliveries: AlertDelivery[] }>('list_alert_deliveries', { limit: 20 }),
      read<{ members: Member[] }>('/api/auth/organization/list-members?limit=200'),
    ]);
    const names: Record<string, string> = Object.fromEntries(members.map((m) => [m.userId, m.user.name || m.user.email]));
    return { settings, channels, deliveries, names, at: Date.now() };
  }, null),
);

/** The members, and for an owner the invitations waiting: Better Auth lets only owners list them. */
export const getMembers = createServerFn({ method: 'GET' }).handler(async () => {
  const [{ members }, session] = await Promise.all([
    read<{ members: Member[] }>('/api/auth/organization/list-members?limit=200'),
    read<{ organization: { role: Role } | null }>('/api/session'),
  ]);
  const invitations = session.organization?.role === 'owner' ? await read<Invitation[]>('/api/auth/organization/list-invitations') : [];
  return { members, invitations: invitations.filter((i) => i.status === 'pending'), at: Date.now() };
});

export const getAccount = createServerFn({ method: 'GET' }).handler(async () => {
  const [current, sessions, accounts, options] = await Promise.all([
    read<{ session: { token: string } }>('/api/auth/get-session'),
    read<SessionRow[]>('/api/auth/list-sessions'),
    read<{ providerId: string }[]>('/api/auth/list-accounts'),
    read<{ github: boolean }>('/api/sign-in-options'),
  ]);
  return {
    // The current session's token stays out of the page: it is the httpOnly cookie's value.
    sessions: sessions.map(({ token, userAgent, ipAddress, updatedAt }) =>
      token === current.session.token ? { token: null, userAgent, ipAddress, updatedAt } : { token, userAgent, ipAddress, updatedAt },
    ),
    github: { offered: options.github, linked: accounts.some((a) => a.providerId === 'github') },
    at: Date.now(),
  };
});

export const getInvitation = createServerFn({ method: 'GET' })
  .validator((invitationId: string) => invitationId)
  .handler(async ({ data: invitationId }) => {
    const res = await callApi(`/api/auth/organization/get-invitation?id=${encodeURIComponent(invitationId)}`);
    if (!res.ok) return null;
    const invitation: { id: string; organizationName: string; role: string; inviterEmail: string; status: string; expiresAt: string } = await res.json();
    return invitation;
  });
