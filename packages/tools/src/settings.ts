import { DEFAULT_AUDIT_RETENTION_DAYS, type OrgScope, type OrgSettings } from '@signforge/db';
import { z } from 'zod';
import { displayHours, ifVersion, locale, timezone } from './fields';
import { UNREACHABLE_AFTER_MS } from './screen-state';
import { defineTool, isAgent, ToolError } from './tool';
import { auditRetentionDays, editorsPublish, outputs, rule, type AlertKind, type AlertRule, type SettingsView } from './outputs';

const DEFAULT_ALERTS: Record<AlertKind, AlertRule> = {
  screen_offline: { who: 'editors', email: true, slack: false, webhook: false },
  publish_finished: { who: 'editors', email: true, slack: false, webhook: false },
  agent_refused: { who: 'owners', email: true, slack: false, webhook: false },
  // Its email goes only to those of them who may approve: owners, and editors while editors publish.
  publish_requested: { who: 'editors', email: true, slack: false, webhook: false },
};

/**
 * Each kind's rule with `change`'s fields over `base`'s. Stored rules are read over the defaults,
 * so a rule stored before Slack and the webhook existed has them off.
 */
const mergeRules = (base: Record<AlertKind, AlertRule>, change: Partial<Record<AlertKind, Partial<AlertRule>>>): Record<AlertKind, AlertRule> => ({
  screen_offline: { ...base.screen_offline, ...change.screen_offline },
  publish_finished: { ...base.publish_finished, ...change.publish_finished },
  agent_refused: { ...base.agent_refused, ...change.agent_refused },
  publish_requested: { ...base.publish_requested, ...change.publish_requested },
});

const DEFAULT_UPDATE_WINDOW = { from: '02:00', to: '04:00' };

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 00:00 to 23:59');
const updateWindow = z
  .object({ from: hhmm, to: hhmm })
  .refine((w) => w.from !== w.to, 'the window must not start and end at the same time')
  .describe("When player and system updates may run, in each screen's local time; a window whose end is before its start crosses midnight");

/** A screen syncs every 5 minutes, so less than that would alert on a sync that is merely due. */
const unreachableAfterMinutes = z.number().int().min(5).max(1440).describe('Minutes without a heartbeat before a screen alerts, 5 to 1440');

/** The org's settings with every default filled in. */
export async function orgSettings(org: OrgScope): Promise<SettingsView> {
  return settingsOf(await org.settings.get());
}

/** How long the org's screens may go unheard from before they are unreachable. */
export async function unreachableAfterMs(org: OrgScope): Promise<number> {
  return (await org.settings.get())?.unreachableAfterMs ?? UNREACHABLE_AFTER_MS;
}

function settingsOf(row: OrgSettings | undefined): SettingsView {
  const stored: Partial<Record<AlertKind, Partial<AlertRule>>> = row?.alertsJson ? JSON.parse(row.alertsJson) : {};
  return {
    timezone: row?.timezone ?? null,
    locale: row?.locale ?? null,
    displayHours: row?.displayHoursJson ? JSON.parse(row.displayHoursJson) : null,
    updateWindow: row?.updateWindowJson ? JSON.parse(row.updateWindowJson) : DEFAULT_UPDATE_WINDOW,
    unreachableAfterMinutes: (row?.unreachableAfterMs ?? UNREACHABLE_AFTER_MS) / 60_000,
    editorsPublish: row?.editorsPublish ?? true,
    auditRetentionDays: row?.auditRetentionDays ?? DEFAULT_AUDIT_RETENTION_DAYS,
    alerts: mergeRules(DEFAULT_ALERTS, stored),
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
  output: outputs.get_org_settings,
  example: {},
  handler: async ({ org }) => ({ settings: await orgSettings(org) }),
});

const updateOrgSettings = defineTool({
  name: 'update_org_settings',
  description:
    "Change the organization's settings; owners only. Changes only the fields given; null clears timezone, locale or displayHours. alerts changes the given fields of each alert kind's rule (who gets the email, and whether it goes by email, to Slack and to the webhook). editorsPublish false lets only owners publish. auditRetentionDays is how long audit rows are kept, 30 to 3650 days. An agent may not change editorsPublish or auditRetentionDays. Settings for new screens apply to screens paired afterwards. Pass the version you read as ifVersion so a change made since is not overwritten. Returns { settings }.",
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
      alerts: z
        .object({
          screen_offline: rule.partial().optional(),
          publish_finished: rule.partial().optional(),
          agent_refused: rule.partial().optional(),
          publish_requested: rule.partial().optional(),
        })
        .optional()
        .describe('Per kind, the fields of its rule to change; the rest stay'),
      ifVersion,
    })
    .refine((v) => Object.keys(v).some((k) => k !== 'ifVersion'), 'nothing to change'),
  output: outputs.update_org_settings,
  example: { unreachableAfterMinutes: 15 },
  target: () => ({ kind: 'org', id: 'settings' }),
  handler: async ({ org, actor, input, write }) => {
    // Who publishes, and how long the audit log keeps its trail, are a person's (owner default on M4 Q7, #122): an agent
    // could otherwise widen its own publishing or erase the record of what it did. The CMS's own agent is one too.
    const kept = (['editorsPublish', 'auditRetentionDays'] as const).filter((k) => input[k] !== undefined);
    if (isAgent(actor) && kept.length)
      throw new ToolError('forbidden', `an agent cannot change ${kept.join(' or ')}: ask an owner to change it in the CMS`);
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
          ...(input.alerts ? { alertsJson: JSON.stringify(mergeRules(settingsOf(current).alerts, input.alerts)) } : {}),
        },
        input.ifVersion,
      ),
    );
    return { settings: settingsOf(row) };
  },
});

export const settingsTools = [getOrgSettings, updateOrgSettings];
