/**
 * Org settings (M3-42): defaults for new screens, the update window, how long a screen may go
 * unheard from before it alerts, who gets which alert, whether editors publish (Q7) and how long audit rows are kept (#41). One row per org (`org_settings`),
 * absent until an owner first sets something; every field reads as its default until then.
 */
import type { DisplayHours } from '@signforge/contract';
import { DEFAULT_AUDIT_RETENTION_DAYS, type OrgScope, type OrgSettings } from '@signforge/db';
import { z } from 'zod';
import { displayHours, ifVersion, locale, timezone, version } from './fields';
import { UNREACHABLE_AFTER_MS } from './screen-state';
import { defineTool } from './tool';

/** The alerts there are. Only `screen_offline` is sent today; `publish_finished` waits for the alert queue (#94), `agent_refused` for agents (Milestone 4). */
const ALERT_KINDS = ['screen_offline', 'publish_finished', 'agent_refused'] as const;
type AlertKind = (typeof ALERT_KINDS)[number];

/** Who gets an alert: owners, owners and editors, or every member. */
const AUDIENCES = ['owners', 'editors', 'everyone'] as const;
export type Audience = (typeof AUDIENCES)[number];

const rule = z.object({ who: z.enum(AUDIENCES), email: z.boolean().describe('Send it by email') });
type AlertRule = z.output<typeof rule>;

const DEFAULT_ALERTS: Record<AlertKind, AlertRule> = {
  screen_offline: { who: 'editors', email: true },
  publish_finished: { who: 'editors', email: true },
  agent_refused: { who: 'owners', email: true },
};

const DEFAULT_UPDATE_WINDOW = { from: '02:00', to: '04:00' };

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 00:00 to 23:59');
const updateWindow = z
  .object({ from: hhmm, to: hhmm })
  .refine((w) => w.from !== w.to, 'the window must not start and end at the same time')
  .describe("When player and system updates may run, in each screen's local time; a window whose end is before its start crosses midnight");

/** A screen syncs every 5 minutes, so less than that would alert on a sync that is merely due. */
const unreachableAfterMinutes = z.number().int().min(5).max(1440).describe('Minutes without a heartbeat before a screen alerts, 5 to 1440');

const editorsPublish = z.boolean().describe('Whether editors may publish to screens; when false, only owners publish');

/**
 * At least a month, so an owner cannot clear the record of what was just done; at most ten years,
 * so the log D1 holds stays bounded.
 */
const auditRetentionDays = z
  .number()
  .int()
  .min(30)
  .max(3650)
  .describe('Days audit rows are kept before the daily job deletes them, 30 to 3650; 365 by default');

const settingsView = z.object({
  timezone: z.string().nullable().describe('Default time zone for new screens; null for none set'),
  locale: z.string().nullable().describe('Default locale for new screens; null for the player default'),
  displayHours: z.custom<DisplayHours>().nullable().describe('Default display hours for new screens; null for always on'),
  updateWindow: z.object({ from: z.string(), to: z.string() }),
  unreachableAfterMinutes: z.number(),
  editorsPublish,
  auditRetentionDays,
  alerts: z.object({ screen_offline: rule, publish_finished: rule, agent_refused: rule }),
  version: version.describe('1 until first set, then moves on with every change; pass it as ifVersion to update only what you read'),
  updatedAt: z.number().nullable(),
});
type SettingsView = z.output<typeof settingsView>;

/** The org's settings with every default filled in. */
export async function orgSettings(org: OrgScope): Promise<SettingsView> {
  return settingsOf(await org.settings.get());
}

/** How long the org's screens may go unheard from before they are unreachable. */
export async function unreachableAfterMs(org: OrgScope): Promise<number> {
  return (await org.settings.get())?.unreachableAfterMs ?? UNREACHABLE_AFTER_MS;
}

function settingsOf(row: OrgSettings | undefined): SettingsView {
  const stored: Partial<Record<AlertKind, AlertRule>> = row?.alertsJson ? JSON.parse(row.alertsJson) : {};
  return {
    timezone: row?.timezone ?? null,
    locale: row?.locale ?? null,
    displayHours: row?.displayHoursJson ? JSON.parse(row.displayHoursJson) : null,
    updateWindow: row?.updateWindowJson ? JSON.parse(row.updateWindowJson) : DEFAULT_UPDATE_WINDOW,
    unreachableAfterMinutes: (row?.unreachableAfterMs ?? UNREACHABLE_AFTER_MS) / 60_000,
    editorsPublish: row?.editorsPublish ?? true,
    auditRetentionDays: row?.auditRetentionDays ?? DEFAULT_AUDIT_RETENTION_DAYS,
    alerts: { ...DEFAULT_ALERTS, ...stored },
    version: row?.rowVersion ?? 1,
    updatedAt: row?.updatedAt ?? null,
  };
}

const getOrgSettings = defineTool({
  name: 'get_org_settings',
  description:
    "Read the organization's settings: defaults for new screens (time zone, locale, display hours), the update window, how many minutes a screen may go without a heartbeat before it alerts, who gets each alert, whether editors may publish, and how many days audit rows are kept. Returns { settings }.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({}),
  output: z.object({ settings: settingsView }),
  example: {},
  handler: async ({ org }) => ({ settings: await orgSettings(org) }),
});

const updateOrgSettings = defineTool({
  name: 'update_org_settings',
  description:
    "Change the organization's settings; owners only. Changes only the fields given; null clears timezone, locale or displayHours. alerts sets the rule for each alert kind given. editorsPublish false lets only owners publish. auditRetentionDays is how long audit rows are kept, 30 to 3650 days. Settings for new screens apply to screens paired afterwards. Pass the version you read as ifVersion so a change made since is not overwritten. Returns { settings }.",
  scope: 'org:manage',
  minRole: 'owner',
  mutates: true,
  input: z
    .object({
      timezone: timezone.nullable().optional(),
      locale: locale.nullable().optional(),
      displayHours: displayHours.nullable().optional(),
      updateWindow: updateWindow.optional(),
      unreachableAfterMinutes: unreachableAfterMinutes.optional(),
      editorsPublish: editorsPublish.optional(),
      auditRetentionDays: auditRetentionDays.optional(),
      alerts: z.object({ screen_offline: rule.optional(), publish_finished: rule.optional(), agent_refused: rule.optional() }).optional(),
      ifVersion,
    })
    .refine((v) => Object.keys(v).some((k) => k !== 'ifVersion'), 'nothing to change'),
  output: z.object({ settings: settingsView }),
  example: { unreachableAfterMinutes: 15 },
  target: () => ({ kind: 'org', id: 'settings' }),
  handler: async ({ org, input, write }) => {
    const current = await org.settings.get();
    const row = write(
      await org.settings.stage.set(
        {
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          ...(input.locale !== undefined ? { locale: input.locale } : {}),
          ...(input.displayHours !== undefined ? { displayHoursJson: input.displayHours && JSON.stringify(input.displayHours) } : {}),
          ...(input.updateWindow ? { updateWindowJson: JSON.stringify(input.updateWindow) } : {}),
          ...(input.unreachableAfterMinutes ? { unreachableAfterMs: input.unreachableAfterMinutes * 60_000 } : {}),
          ...(input.editorsPublish !== undefined ? { editorsPublish: input.editorsPublish } : {}),
          ...(input.auditRetentionDays ? { auditRetentionDays: input.auditRetentionDays } : {}),
          ...(input.alerts ? { alertsJson: JSON.stringify({ ...settingsOf(current).alerts, ...input.alerts }) } : {}),
        },
        input.ifVersion,
      ),
    );
    return { settings: settingsOf(row) };
  },
});

export const settingsTools = [getOrgSettings, updateOrgSettings];
