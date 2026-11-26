/**
 * The audit log in words (canvas board SettingsAudit): `list_audit_log`'s entries (packages/tools
 * src/audit.ts is the source of truth), the page's filters as that tool's input, who did each
 * thing and through what, what it was, and the CSV export's rows. A screen's Recent events use
 * the same phrases (`eventText`).
 */

import type { CmsAgentClientId, ToolOutput } from '@signforge/tools/outputs';

/** A `list_audit_log` page. */
export type AuditPage = ToolOutput<'list_audit_log'>;

/** One entry of `list_audit_log`. Its detail is as recorded: `{ input }` for a tool (secrets already redacted), the fields kept for a membership change, `{ tool, refused }` for an agent's limit. */
export type AuditEntry = AuditPage['entries'][number];

type ActorKind = AuditEntry['actor']['kind'];

const WHEN = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 } as const;
export type When = keyof typeof WHEN;
export const WHENS: { value: When; label: string }[] = [
  { value: 'day', label: 'Last 24 hours' },
  { value: 'week', label: 'Last 7 days' },
  { value: 'month', label: 'Last 30 days' },
];
export const isWhen = (v: unknown): v is When => typeof v === 'string' && Object.hasOwn(WHEN, v);

/** Who, by kind: the filter's first options. Any other value of `who` is one actor's id (a member's user id). */
const WHO_KINDS = { people: 'user', agents: 'agent', screens: 'device', system: 'system' } as const satisfies Record<string, ActorKind>;
const isWhoKind = (v: string): v is keyof typeof WHO_KINDS => Object.hasOwn(WHO_KINDS, v);
export const WHO_OPTIONS: { value: keyof typeof WHO_KINDS; label: string }[] = [
  { value: 'people', label: 'People' },
  { value: 'agents', label: 'Agents' },
  { value: 'screens', label: 'Screens' },
  { value: 'system', label: 'System' },
];

/**
 * The page's filters, as its URL carries them: kinds, ids and a time span, nothing a person
 * typed. The text search is not here: it can be an email or a name, so it lives in the store
 * and reaches the server in a POST body, never a URL (#140).
 */
export interface AuditFilters {
  who?: string;
  what?: string;
  target?: string;
  targetId?: string;
  when?: When;
}

/** `list_audit_log`'s input for the filters and the search (`query`), `when` counted back from `now`. */
export function auditInput(f: AuditFilters, query: string, now: number): Record<string, unknown> {
  return {
    ...(f.who ? { actor: isWhoKind(f.who) ? { kind: WHO_KINDS[f.who] } : { id: f.who } } : {}),
    ...(f.what ? { action: f.what } : {}),
    ...(f.target ? { target: { kind: f.target, ...(f.targetId ? { id: f.targetId } : {}) } } : {}),
    ...(f.when ? { from: now - WHEN[f.when] } : {}),
    ...(query ? { query } : {}),
  };
}

/** What each kind of target is called. `org` is the settings row `update_org_settings` changes. */
export const TARGET_KINDS: { value: string; label: string }[] = [
  { value: 'screen', label: 'Screen' },
  { value: 'group', label: 'Group' },
  { value: 'spot', label: 'Spot' },
  { value: 'asset', label: 'Asset' },
  { value: 'brand_kit', label: 'Brand kit' },
  { value: 'data_source', label: 'Data source' },
  { value: 'connection', label: 'Connection' },
  { value: 'connection_authorization', label: 'Connection request' },
  { value: 'credential', label: 'Screen credential' },
  { value: 'playlist', label: 'Playlist' },
  { value: 'schedule_entry', label: 'Schedule entry' },
  { value: 'template_version', label: 'Template version' },
  { value: 'member', label: 'Member' },
  { value: 'invitation', label: 'Invitation' },
  { value: 'organization', label: 'Organization' },
  { value: 'alert_channel', label: 'Alert channel' },
  { value: 'ai_provider', label: 'AI provider' },
  { value: 'alert_delivery', label: 'Alert delivery' },
  { value: 'org', label: 'Settings' },
  { value: 'publish', label: 'Publish' },
  { value: 'publish_request', label: 'Publish request' },
];
export const targetLabel = (kind: string) => TARGET_KINDS.find((t) => t.value === kind)?.label ?? kind.replaceAll('_', ' ');

/**
 * Every action the log records, the short phrase for it, and the group the What filter lists it
 * under: each tool that changes something (test/registry checks), Better Auth's membership changes
 * (apps/api src/auth/options.ts) and an agent refused for its limits.
 */
export const ACTIONS: Record<string, { group: string; words: string }> = {
  claim_screen: { group: 'Screens', words: 'Paired' },
  update_screen_labels: { group: 'Screens', words: 'Labels changed' },
  update_screen: { group: 'Screens', words: 'Changed' },
  screen_command: { group: 'Screens', words: 'Command sent' },
  // Recorded before #345 merged them into update_screen, screen_command, save_group and the content saves: their rows keep these names.
  rename_screen: { group: 'Screens', words: 'Renamed' },
  update_screen_settings: { group: 'Screens', words: 'Settings changed' },
  set_display_override: { group: 'Screens', words: 'Woken or put to sleep' },
  identify_screen: { group: 'Screens', words: 'Identified' },
  restart_screen: { group: 'Screens', words: 'Player restarted' },
  revoke_screen_credential: { group: 'Screens', words: 'Credential revoked' },
  publish_manifest_to_screen: { group: 'Screens', words: 'Published' },
  save_group: { group: 'Groups', words: 'Saved' },
  create_group: { group: 'Groups', words: 'Created' },
  rename_group: { group: 'Groups', words: 'Renamed' },
  delete_group: { group: 'Groups', words: 'Deleted' },
  set_group_members: { group: 'Groups', words: 'Screens set' },
  add_group_members: { group: 'Groups', words: 'Screens added' },
  remove_group_members: { group: 'Groups', words: 'Screens removed' },
  save_spot: { group: 'Spots', words: 'Saved' },
  create_spot: { group: 'Spots', words: 'Created' },
  update_spot: { group: 'Spots', words: 'Draft changed' },
  revert_spot_draft: { group: 'Spots', words: "Agent's draft rejected, or put back" },
  keep_spot_draft: { group: 'Spots', words: "Agent's draft kept" },
  delete_spot: { group: 'Spots', words: 'Deleted' },
  save_playlist: { group: 'Playlists', words: 'Saved' },
  create_playlist: { group: 'Playlists', words: 'Created' },
  update_playlist: { group: 'Playlists', words: 'Draft changed' },
  revert_playlist_draft: { group: 'Playlists', words: "Agent's draft rejected, or put back" },
  keep_playlist_draft: { group: 'Playlists', words: "Agent's draft kept" },
  delete_playlist: { group: 'Playlists', words: 'Deleted' },
  set_default_playlist: { group: 'Playlists', words: 'Made the default' },
  save_schedule_entry: { group: 'Schedule', words: 'Schedule saved' },
  create_schedule_entry: { group: 'Schedule', words: 'Scheduled' },
  start_takeover: { group: 'Schedule', words: 'Takeover made' },
  publish_takeover: { group: 'Schedule', words: 'Takeover made and published' },
  update_schedule_entry: { group: 'Schedule', words: 'Schedule changed' },
  delete_schedule_entry: { group: 'Schedule', words: 'Unscheduled' },
  end_takeover: { group: 'Schedule', words: 'Takeover ended' },
  publish: { group: 'Publishes', words: 'Published' },
  roll_back_publish: { group: 'Publishes', words: 'Rolled back' },
  request_publish: { group: 'Publishes', words: 'Asked to publish' },
  approve_publish_request: { group: 'Publishes', words: 'Request approved' },
  decline_publish_request: { group: 'Publishes', words: 'Request declined' },
  reopen_publish_request: { group: 'Publishes', words: 'Request put back' },
  create_asset_upload: { group: 'Assets', words: 'Image upload started' },
  renew_asset_upload: { group: 'Assets', words: 'Upload renewed' },
  finalize_asset: { group: 'Assets', words: 'Image checked' },
  create_video_upload: { group: 'Assets', words: 'Video upload started' },
  finalize_video_upload: { group: 'Assets', words: 'Video checked' },
  delete_asset: { group: 'Assets', words: 'Deleted' },
  save_brand_kit: { group: 'Brand kits', words: 'Saved' },
  create_brand_kit: { group: 'Brand kits', words: 'Created' },
  update_brand_kit: { group: 'Brand kits', words: 'Changed' },
  set_default_brand_kit: { group: 'Brand kits', words: 'Made the default' },
  assign_brand_kit: { group: 'Brand kits', words: 'Brand kit changed' },
  save_data_source: { group: 'Data sources', words: 'Saved' },
  create_data_source: { group: 'Data sources', words: 'Created' },
  update_data_source: { group: 'Data sources', words: 'Changed' },
  delete_data_source: { group: 'Data sources', words: 'Deleted' },
  read_table: { group: 'Data sources', words: 'Table read from an address' },
  start_connection: { group: 'Connections', words: 'Connection started' },
  finish_connection: { group: 'Connections', words: 'Connected' },
  disconnect: { group: 'Connections', words: 'Disconnected' },
  register_template_version: { group: 'Templates', words: 'Version registered' },
  set_template_version_status: { group: 'Templates', words: 'Version status changed' },
  update_org_settings: { group: 'Organization', words: 'Settings changed' },
  set_slack_alert_channel: { group: 'Alerts', words: 'Slack channel set' },
  set_webhook_alert_channel: { group: 'Alerts', words: 'Webhook set' },
  remove_alert_channel: { group: 'Alerts', words: 'Channel removed' },
  test_alert_channel: { group: 'Alerts', words: 'Test alert sent' },
  retry_alert_delivery: { group: 'Alerts', words: 'Delivery retried' },
  save_ai_provider: { group: 'Agents', words: 'Model key or models saved' },
  test_ai_provider: { group: 'Agents', words: 'Model key tested' },
  remove_ai_provider: { group: 'Agents', words: 'Model key removed' },
  create_organization: { group: 'Organization', words: 'Created' },
  update_organization: { group: 'Organization', words: 'Name changed' },
  invite_member: { group: 'Members', words: 'Invited' },
  cancel_invitation: { group: 'Members', words: 'Invitation cancelled' },
  reject_invitation: { group: 'Members', words: 'Invitation declined' },
  accept_invitation: { group: 'Members', words: 'Joined' },
  update_member_role: { group: 'Members', words: 'Role changed' },
  remove_member: { group: 'Members', words: 'Removed' },
  leave_organization: { group: 'Members', words: 'Left' },
  create_agent_grant: { group: 'Agents', words: 'Agent connected' },
  update_agent_grant_scopes: { group: 'Agents', words: 'Agent’s scopes changed' },
  revoke_agent_grant: { group: 'Agents', words: 'Agent disconnected' },
  rate_limited: { group: 'Agents', words: 'Refused: over its limits' },
};

/** The What filter's options, in ACTIONS' groups. */
export const ACTION_GROUPS = Object.entries(ACTIONS).reduce<{ group: string; actions: { value: string; label: string }[] }[]>(
  (groups, [value, { group, words }]) => {
    const last = groups.at(-1);
    if (last?.group === group) last.actions.push({ value, label: words });
    else groups.push({ group, actions: [{ value, label: words }] });
    return groups;
  },
  [],
);

const SETTINGS: [string, string][] = [
  ['displayHours', 'display hours'],
  ['timezone', 'time zone'],
  ['orientation', 'orientation'],
  ['locale', 'language'],
];

/**
 * Each content save (#345 PR 4), said as the tools it replaced said it: without its id it was their create, with it
 * their update. A brand kit made the default by it says so.
 */
const SAVES: Record<string, { id: string; created: string; changed: string }> = {
  save_spot: { id: 'spotId', created: 'create_spot', changed: 'update_spot' },
  save_playlist: { id: 'playlistId', created: 'create_playlist', changed: 'update_playlist' },
  save_schedule_entry: { id: 'scheduleEntryId', created: 'create_schedule_entry', changed: 'update_schedule_entry' },
  save_brand_kit: { id: 'brandKitId', created: 'create_brand_kit', changed: 'update_brand_kit' },
  save_data_source: { id: 'dataSourceId', created: 'create_data_source', changed: 'update_data_source' },
};

/** What each of `screen_command`'s commands did, as the tools it replaced said it. */
const SCREEN_COMMANDS: Record<string, string> = {
  identify: 'Identified',
  restart: 'Player restarted',
  display_on: 'Woken from the CMS',
  display_off: 'Put to sleep from the CMS',
  display_auto: 'Back to its display hours',
};
const MEMBERSHIP: Record<string, string> = { add: 'Screens added', remove: 'Screens removed', set: 'Screens set' };

const capital = (s: string) => `${s[0]!.toUpperCase()}${s.slice(1)}`;
const text = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** What was done (the action and what it was given) as a phrase. */
export function eventText(e: { action: string; input: Readonly<Record<string, unknown>> }): string {
  const name = text(e.input.name);
  const role = text(e.input.role);
  const save = SAVES[e.action];
  if (save) {
    const words = ACTIONS[e.input[save.id] === undefined ? save.created : save.changed]!.words;
    return e.action === 'save_brand_kit' && e.input.makeDefault === true ? `${words} · made the default` : words;
  }
  switch (e.action) {
    case 'screen_command':
      return SCREEN_COMMANDS[text(e.input.command) ?? ''] ?? ACTIONS.screen_command!.words;
    case 'set_display_override':
      return e.input.state === 'on' ? 'Woken from the CMS' : e.input.state === 'off' ? 'Put to sleep from the CMS' : 'Back to its display hours';
    case 'save_group': {
      const membership = text(e.input.membership);
      const screens = MEMBERSHIP[membership ?? ''];
      if (e.input.groupId === undefined) return name ? `Created ${name}` : 'Created';
      if (name && screens) return `Renamed to ${name} · ${screens.toLowerCase()}`;
      return name ? `Renamed to ${name}` : (screens ?? ACTIONS.save_group!.words);
    }
    case 'rename_screen':
    case 'rename_group':
    case 'update_organization':
      return name ? `Renamed to ${name}` : (ACTIONS[e.action]?.words ?? 'Renamed');
    case 'update_screen':
    case 'update_screen_settings': {
      const changed = SETTINGS.filter(([key]) => key in e.input).map(([, word]) => word);
      if (!changed.length) return name ? `Renamed to ${name}` : 'Settings changed';
      if (name) changed.unshift('name');
      const list = changed.length > 1 ? `${changed.slice(0, -1).join(', ')} and ${changed.at(-1)}` : changed[0]!;
      return `${capital(list)} changed`;
    }
    case 'invite_member':
      return `Invited ${text(e.input.email) ?? 'someone'}${role ? ` as ${role}` : ''}`;
    case 'accept_invitation':
    case 'update_member_role':
      return role ? `${ACTIONS[e.action]!.words} · ${role}` : ACTIONS[e.action]!.words;
    default:
      return capital(ACTIONS[e.action]?.words ?? e.action.replaceAll('_', ' '));
  }
}

/** The input a tool was given, or a membership change's own fields; a cancel's invitee too, which the tool records apart (#321). */
const inputOf = (e: AuditEntry): Record<string, unknown> => {
  const input = e.detail.input;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return e.detail;
  const more = e.detail.detail;
  const invitee = e.action === 'cancel_invitation' && typeof more === 'object' && more !== null && 'email' in more ? { email: more.email } : {};
  return { ...input, ...invitee };
};

/** The playlist a publish made the org's first default (#243), from its row's `detail`. */
function madeDefaultOf(e: AuditEntry): string | undefined {
  const more = e.detail.detail;
  const made = typeof more === 'object' && more !== null && 'madeDefault' in more ? more.madeDefault : undefined;
  return typeof made === 'object' && made !== null && 'name' in made ? text(made.name) : undefined;
}

/** What an entry did, in words: a publish, or an approved request's (M4-09), that made the default says so. */
export function whatText(e: AuditEntry): string {
  const made = e.action === 'publish' || e.action === 'approve_publish_request' ? madeDefaultOf(e) : undefined;
  const words = eventText({ action: e.action, input: inputOf(e) });
  return made ? `${words} · made ${made} the default playlist` : words;
}

/** What it was given, short: `name: Lobby · state: on`; the target's own id is left out, and a refusal says why. */
export function detailText(e: AuditEntry): string {
  const { refused, ...rest } = e.action === 'rate_limited' ? e.detail : { ...inputOf(e), refused: e.detail.refused };
  const parts = Object.entries(rest)
    .filter(([, v]) => v !== e.target?.id && v !== undefined)
    .map(([k, v]) => `${k}: ${short(v)}`);
  const why = typeof refused === 'object' && refused !== null && 'message' in refused ? text(refused.message) : undefined;
  if (why) parts.push(`refused: ${why}`);
  return parts.join(' · ');
}

function short(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
}

/** Who did it: "You" (given `me`), a member's name, an agent, a screen or the system. A user no longer a member is named by id. */
/** The built-in agent's client id (`CMS_AGENT_CLIENT_ID` in packages/tools): it acts as the member who asked it. */
export const CMS_AGENT: CmsAgentClientId = 'cms-agent';

export function whoText(e: AuditEntry, names: ReadonlyMap<string, string>, me?: string): string {
  switch (e.actor.kind) {
    case 'user': {
      const who = e.actor.id === me ? 'You' : (names.get(e.actor.id) ?? `Former member ${e.actor.id}`);
      // The built-in agent acts as the member who asked it (#263): their name, and that it was the agent.
      return e.actor.clientId === CMS_AGENT ? `${who} via agent` : who;
    }
    case 'agent':
      return `Agent ${e.actor.clientId ?? e.actor.id}`;
    case 'device':
      return `Screen ${e.actor.id}`;
    case 'system':
      return e.actor.id === 'sf-push' ? 'sf push' : 'SignForge';
  }
}

/**
 * An agent named as a page names it (the approvals queue's `askerName`, #410): its client's plain name and ", agent";
 * "An agent" when the name may not be shown; "An agent no longer connected" only once it is gone.
 */
export function agentWho(a: { name: string | null; gone: boolean } | undefined): string {
  if (a?.name) return `${a.name}, agent`;
  return a?.gone ? 'An agent no longer connected' : 'An agent';
}

/** What it came through: the CMS, an agent's client, a screen, or the system. */
export function viaText(e: AuditEntry): string {
  switch (e.actor.kind) {
    case 'user':
      // A member acts only with a session, and only the CMS has one (apps/api src/auth/options.ts).
      return 'CMS';
    case 'agent':
      return `Agent · ${e.actor.clientId ?? e.actor.id}`;
    case 'device':
      return 'Screen';
    case 'system':
      return e.actor.clientId === 'sf-push' ? 'sf push' : 'System';
  }
}

/** An entry's time in the org's zone: "14:20" today, "Mon 17 Nov 14:20" before, with the year in another year. */
export function auditTime(at: number, timezone: string, now: number): string {
  const day = (d: number) => new Date(d).toLocaleDateString('en-CA', { timeZone: timezone });
  const time = new Date(at).toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  if (day(at) === day(now)) return time;
  const sameYear = day(at).slice(0, 4) === day(now).slice(0, 4);
  const date = new Date(at).toLocaleDateString('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
  return `${date.replace(',', '')} ${time}`;
}

/** The CSV's columns, in order. */
export const CSV_HEADER = ['time', 'who', 'actor_kind', 'actor_id', 'via', 'action', 'what', 'target_kind', 'target_id', 'detail'];

/** One entry as the CSV's row: the time in UTC (ISO 8601), the words the page shows (a member by name, never "You": others read the file), and the detail as recorded. */
export const csvRow = (e: AuditEntry, names: ReadonlyMap<string, string>): string[] => [
  new Date(e.at).toISOString(),
  whoText(e, names),
  e.actor.kind,
  e.actor.id,
  viaText(e),
  e.action,
  whatText(e),
  e.target?.kind ?? '',
  e.target?.id ?? '',
  JSON.stringify(e.detail),
];

/**
 * One CSV line (RFC 4180, CRLF). A cell a spreadsheet would run as a formula (`=`, `+`, `-`, `@`,
 * tab or CR first) gets a leading `'`: inputs are whatever a person or an agent typed.
 */
export function csvLine(cells: readonly string[]): string {
  return `${cells
    .map((c) => {
      const safe = /^[=+\-@\t\r]/.test(c) ? `'${c}` : c;
      return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
    })
    .join(',')}\r\n`;
}
