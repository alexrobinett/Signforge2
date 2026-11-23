/**
 * What the Settings and Account pages read: `get_org_settings`'s output, the alert channels and
 * deliveries, and Better Auth's members, invitations and sessions.
 */
import type { ToolOutput } from '@signforge/tools/outputs';
import type { Role } from '~/server/shell.functions';

export type OrgSettings = ToolOutput<'get_org_settings'>['settings'];
export type AlertKind = keyof OrgSettings['alerts'];
/** `who` is for email; Slack and the webhook post to one place each (#88). */
export type AlertRule = OrgSettings['alerts'][AlertKind];
export type Audience = AlertRule['who'];

/** `get_alert_channels`' view of a channel: its host, never its URL or secret. */
export type AlertChannel = NonNullable<ToolOutput<'get_alert_channels'>['slack']>;

/** One row of `list_alert_deliveries`. */
export type AlertDelivery = ToolOutput<'list_alert_deliveries'>['deliveries'][number];
/** The org's own model provider (#261), or null while it uses the demo model. */
export type AiProvider = NonNullable<ToolOutput<'get_ai_provider'>['provider']>;
/** What the page calls each provider. */
const AI_PROVIDER_NAMES: Record<AiProvider['provider'], string> = { anthropic: 'Anthropic', 'openai-compatible': 'The endpoint' };

/** Why a test of the key could not reach the provider, in words. */
export function aiTestProblem(problem: NonNullable<ToolOutput<'test_ai_provider'>['problem']>, provider: AiProvider['provider']): string {
  const name = AI_PROVIDER_NAMES[provider];
  if (problem === 'refused') return `${name} refused the key. It may have been revoked or rotated: replace it.`;
  if (problem === 'busy') return `${name} is busy. Try again in a minute.`;
  if (problem === 'blocked') return 'SignForge cannot reach that address: it must be public https, and must not redirect to another one.';
  return provider === 'anthropic'
    ? 'Anthropic did not answer. Try again.'
    : 'The endpoint did not answer as an OpenAI-style API. Check its address, and try again.';
}

export const CHANNEL_LABELS: Record<AlertDelivery['channel'], string> = { email: 'Email', slack: 'Slack', webhook: 'Webhook' };

/** The events a delivery carries, as the log names them. */
export const EVENT_LABELS: Record<string, string> = { 'screen.offline': 'Screen offline', 'screen.back': 'Screen back', test: 'Test' };

export interface Member {
  id: string;
  role: Role;
  createdAt: string;
  userId: string;
  user: { id: string; name: string; email: string };
}

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  status: 'pending' | 'accepted' | 'rejected' | 'canceled';
  expiresAt: string;
}

export interface SessionRow {
  token: string;
  userAgent: string | null;
  ipAddress: string | null;
  updatedAt: string;
}

export const ROLES: { value: Role; label: string }[] = [
  { value: 'owner', label: 'Owner' },
  { value: 'editor', label: 'Editor' },
  { value: 'viewer', label: 'Viewer' },
];

export const isRole = (v: unknown): v is Role => ROLES.some((r) => r.value === v);

export const AUDIENCES: { value: Audience; label: string }[] = [
  { value: 'owners', label: 'Owners' },
  { value: 'editors', label: 'Owners and editors' },
  { value: 'everyone', label: 'Everyone' },
];

export const isAudience = (v: unknown): v is Audience => AUDIENCES.some((a) => a.value === v);

/** The alerts, in the order the Notifications page lists them, and whether anything sends them yet. */
export const ALERTS: { kind: AlertKind; when: string; note: string }[] = [
  { kind: 'screen_offline', when: 'A screen goes offline, and when it is back', note: '' },
  { kind: 'publish_finished', when: 'A publish reaches every screen', note: 'Once every screen it switched plays it, checked every 5 minutes' },
  { kind: 'agent_refused', when: 'An agent is refused', note: 'Sent once agents can connect' },
];

/** What each role may do: the table on the Members page, matching ROLE_SCOPES, the org's choice of who publishes, and the tools' minimum roles. */
export const roleTable = (editorsPublish: boolean): { what: string; owner: boolean; editor: boolean; viewer: boolean }[] => [
  { what: 'See screens, spots and assets', owner: true, editor: true, viewer: true },
  { what: 'Edit spots, playlists and assets', owner: true, editor: true, viewer: false },
  { what: 'Publish to screens', owner: true, editor: editorsPublish, viewer: false },
  { what: 'Pair, restart and rename screens', owner: true, editor: true, viewer: false },
  { what: 'Revoke a screen', owner: true, editor: false, viewer: false },
  { what: 'Members, roles and organization settings', owner: true, editor: false, viewer: false },
];

/** "Chrome on macOS", from a user agent, for the sessions list. */
export function describeAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'A browser';
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  return os ? `${browser} on ${os}` : browser;
}
