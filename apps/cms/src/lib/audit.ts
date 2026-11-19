/**
 * The audit log in words (canvas board SettingsAudit): `list_audit_log`'s entries (packages/tools
 * src/audit.ts is the source of truth), the page's filters as that tool's input, who did each
 * thing and through what, what it was, and the CSV export's rows. A screen's Recent events use
 * the same phrases (`eventText`).
 */

type ActorKind = 'user' | 'agent' | 'device' | 'system';

/** One entry of `list_audit_log`. */
export interface AuditEntry {
  at: number;
  actor: { kind: ActorKind; id: string; clientId: string | null };
  action: string;
  target: { kind: string; id: string } | null;
  /** As recorded: `{ input }` for a tool (secrets already redacted), the fields kept for a membership change, `{ tool, refused }` for an agent's limit. */
  detail: Record<string, unknown>;
}

export interface AuditPage {
  entries: AuditEntry[];
  next: string | null;
}

const WHEN = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 } as const;
export type When = keyof typeof WHEN;
export const WHENS: { value: When; label: string }[] = [
  { value: 'day', label: 'Last 24 hours' },
  { value: 'week', label: 'Last 7 days' },
  { value: 'month', label: 'Last 30 days' },
];
export const isWhen = (v: unknown): v is When => typeof v === 'string' && v in WHEN;

/** Who, by kind: the filter's first options. Any other value of `who` is one actor's id (a member's user id). */
const WHO_KINDS = { people: 'user', agents: 'agent', screens: 'device', system: 'system' } as const satisfies Record<string, ActorKind>;
const isWhoKind = (v: string): v is keyof typeof WHO_KINDS => v in WHO_KINDS;
export const WHO_OPTIONS: { value: keyof typeof WHO_KINDS; label: string }[] = [
  { value: 'people', label: 'People' },
  { value: 'agents', label: 'Agents' },
  { value: 'screens', label: 'Screens' },
  { value: 'system', label: 'System' },
];

/** The page's filters, as its URL carries them. */
export interface AuditFilters {
  who?: string;
  what?: string;
  target?: string;
  targetId?: string;
  when?: When;
  q?: string;
}

/** `list_audit_log`'s input for the filters, `when` counted back from `now`. */
export function auditInput(f: AuditFilters, now: number): Record<string, unknown> {
  return {
    ...(f.who ? { actor: isWhoKind(f.who) ? { kind: WHO_KINDS[f.who] } : { id: f.who } } : {}),
    ...(f.what ? { action: f.what } : {}),
    ...(f.target ? { target: { kind: f.target, ...(f.targetId ? { id: f.targetId } : {}) } } : {}),
    ...(f.when ? { from: now - WHEN[f.when] } : {}),
    ...(f.q ? { query: f.q } : {}),
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
  { value: 'template_version', label: 'Template version' },
  { value: 'member', label: 'Member' },
  { value: 'invitation', label: 'Invitation' },
  { value: 'organization', label: 'Organization' },
  { value: 'org', label: 'Settings' },
];
export const targetLabel = (kind: string) => TARGET_KINDS.find((t) => t.value === kind)?.label ?? kind.replaceAll('_', ' ');

/**
 * Every action the log records, the short phrase for it, and the group the What filter lists it
 * under: each tool that changes something (test/registry checks), Better Auth's membership changes
 * (apps/api src/auth/options.ts) and an agent refused for its limits.
 */
export const ACTIONS: Record<string, { group: string; words: string }> = {
  claim_screen: { group: 'Screens', words: 'Paired' },
  rename_screen: { group: 'Screens', words: 'Renamed' },
  update_screen_settings: { group: 'Screens', words: 'Settings changed' },
  set_display_override: { group: 'Screens', words: 'Woken or put to sleep' },
  identify_screen: { group: 'Screens', words: 'Identified' },
  restart_screen: { group: 'Screens', words: 'Player restarted' },
  revoke_screen_credential: { group: 'Screens', words: 'Credential revoked' },
  publish_manifest_to_screen: { group: 'Screens', words: 'Published' },
  create_group: { group: 'Groups', words: 'Created' },
  rename_group: { group: 'Groups', words: 'Renamed' },
  delete_group: { group: 'Groups', words: 'Deleted' },
  set_group_members: { group: 'Groups', words: 'Screens set' },
  add_group_members: { group: 'Groups', words: 'Screens added' },
  remove_group_members: { group: 'Groups', words: 'Screens removed' },
  create_spot: { group: 'Spots', words: 'Created' },
  update_spot: { group: 'Spots', words: 'Draft changed' },
  create_asset_upload: { group: 'Assets', words: 'Image upload started' },
  renew_asset_upload: { group: 'Assets', words: 'Upload renewed' },
  finalize_asset: { group: 'Assets', words: 'Image checked' },
  create_video_upload: { group: 'Assets', words: 'Video upload started' },
  finalize_video_upload: { group: 'Assets', words: 'Video checked' },
  delete_asset: { group: 'Assets', words: 'Deleted' },
  create_brand_kit: { group: 'Brand kits', words: 'Created' },
  update_brand_kit: { group: 'Brand kits', words: 'Changed' },
  set_default_brand_kit: { group: 'Brand kits', words: 'Made the default' },
  assign_brand_kit: { group: 'Brand kits', words: 'Brand kit changed' },
  create_data_source: { group: 'Data sources', words: 'Created' },
  update_data_source: { group: 'Data sources', words: 'Changed' },
  delete_data_source: { group: 'Data sources', words: 'Deleted' },
  register_template_version: { group: 'Templates', words: 'Version registered' },
  set_template_version_status: { group: 'Templates', words: 'Version status changed' },
  update_org_settings: { group: 'Organization', words: 'Settings changed' },
  create_organization: { group: 'Organization', words: 'Created' },
  update_organization: { group: 'Organization', words: 'Name changed' },
  invite_member: { group: 'Members', words: 'Invited' },
  cancel_invitation: { group: 'Members', words: 'Invitation cancelled' },
  reject_invitation: { group: 'Members', words: 'Invitation declined' },
  accept_invitation: { group: 'Members', words: 'Joined' },
  update_member_role: { group: 'Members', words: 'Role changed' },
  remove_member: { group: 'Members', words: 'Removed' },
  leave_organization: { group: 'Members', words: 'Left' },
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

const capital = (s: string) => `${s[0]!.toUpperCase()}${s.slice(1)}`;
const text = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** What was done (the action and what it was given) as a phrase. */
export function eventText(e: { action: string; input: Readonly<Record<string, unknown>> }): string {
  const name = text(e.input.name);
  const role = text(e.input.role);
  switch (e.action) {
    case 'set_display_override':
      return e.input.state === 'on' ? 'Woken from the CMS' : e.input.state === 'off' ? 'Put to sleep from the CMS' : 'Back to its display hours';
    case 'rename_screen':
    case 'rename_group':
    case 'update_organization':
      return name ? `Renamed to ${name}` : (ACTIONS[e.action]?.words ?? 'Renamed');
    case 'update_screen_settings': {
      const changed = SETTINGS.filter(([key]) => key in e.input).map(([, word]) => word);
      if (!changed.length) return 'Settings changed';
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

/** The input a tool was given, or a membership change's own fields. */
const inputOf = (e: AuditEntry): Record<string, unknown> => {
  const input = e.detail.input;
  return typeof input === 'object' && input !== null && !Array.isArray(input) ? { ...input } : e.detail;
};

/** What an entry did, in words. */
export const whatText = (e: AuditEntry) => eventText({ action: e.action, input: inputOf(e) });

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

/** Who did it: "You", a member's name, an agent, a screen or the system. A user no longer a member is named by id. */
export function whoText(e: AuditEntry, names: ReadonlyMap<string, string>, me: string): string {
  switch (e.actor.kind) {
    case 'user':
      return e.actor.id === me ? 'You' : (names.get(e.actor.id) ?? `Former member ${e.actor.id}`);
    case 'agent':
      return `Agent ${e.actor.clientId ?? e.actor.id}`;
    case 'device':
      return `Screen ${e.actor.id}`;
    case 'system':
      return e.actor.id === 'sf-push' ? 'sf push' : 'SignForge';
  }
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

/** One entry as the CSV's row: the time in UTC (ISO 8601), the words the page shows, and the detail as recorded. */
export const csvRow = (e: AuditEntry, names: ReadonlyMap<string, string>, me: string): string[] => [
  new Date(e.at).toISOString(),
  whoText(e, names, me),
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
