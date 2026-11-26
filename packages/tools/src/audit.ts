/**
 * The org's audit log (#82): every change a tool, Better Auth's membership endpoints or an agent's
 * limit refusal recorded, newest first, filtered, a page at a time read in SQL. Inputs were
 * redacted when the row was written (`redact()` in ./dispatch.ts) and are returned as stored.
 *
 * An entry carries no id of its own: an agent-limit row's id is longer than the contract's id rules
 * allow (#77), and the cursor, made from each row's time and `rowid` and the org, is what pages.
 */
import { z } from 'zod';
import { shownClientName } from './agent-clients';
import { keysetPage, pageInput } from './paging';
import { defineTool, ToolError } from './tool';
import { ACTOR_KINDS, outputs } from './outputs';

/**
 * Membership changes whose detail names the invitee by email. Better Auth lets only owners list
 * invitations, so only an owner gets the email here, or finds the row by it.
 */
const INVITATIONS = ['invite_member', 'cancel_invitation', 'reject_invitation'];

/** A content save's rows under the create (no id given) and the update (its id given) it replaced (#345 PR 4). */
const saves = (save: string, idKey: string, created: string, changed: string) => ({
  [created]: { actions: [save], inputHas: { [idKey]: false } },
  [changed]: { actions: [save], inputHas: { [idKey]: true } },
});

/**
 * Rows an action's filter finds besides its own. A publish, or an approval's (M4-09), that made the org's first default
 * changed it too (#243). A screen command, a group's save, a content save, a delete, a takeover, an upload and an alert channel set (#345) do
 * what the tools they replaced did: their rows are found under those tools' names, by the input they recorded (or, for
 * an upload's finish, the kind it checked).
 */
const ALSO: Record<string, { actions: readonly string[]; detailHas?: string; inputHas?: Readonly<Record<string, boolean>>; inputHasAny?: readonly string[] }> =
  {
    set_default_playlist: { actions: ['publish', 'approve_publish_request'], detailHas: '"madeDefault"' },
    identify_screen: { actions: ['screen_command'], detailHas: '"command":"identify"' },
    restart_screen: { actions: ['screen_command'], detailHas: '"command":"restart"' },
    set_display_override: { actions: ['screen_command'], detailHas: '"command":"display_' },
    // A screen's update (#345 PR 3) that renamed it, or changed a setting: found under each tool it replaced (#507).
    rename_screen: { actions: ['update_screen'], inputHas: { name: true } },
    update_screen_settings: { actions: ['update_screen'], inputHasAny: ['timezone', 'locale', 'orientation', 'displayHours'] },
    create_group: { actions: ['save_group'], inputHas: { groupId: false } },
    rename_group: { actions: ['save_group'], inputHas: { groupId: true, name: true } },
    set_group_members: { actions: ['save_group'], detailHas: '"membership":"set"', inputHas: { groupId: true } },
    add_group_members: { actions: ['save_group'], detailHas: '"membership":"add"', inputHas: { groupId: true } },
    remove_group_members: { actions: ['save_group'], detailHas: '"membership":"remove"', inputHas: { groupId: true } },
    ...saves('save_spot', 'spotId', 'create_spot', 'update_spot'),
    ...saves('save_playlist', 'playlistId', 'create_playlist', 'update_playlist'),
    ...saves('save_schedule_entry', 'scheduleEntryId', 'create_schedule_entry', 'update_schedule_entry'),
    ...saves('save_brand_kit', 'brandKitId', 'create_brand_kit', 'update_brand_kit'),
    ...saves('save_data_source', 'dataSourceId', 'create_data_source', 'update_data_source'),
    // Its outcome, which the save records (`madeDefault`), not its input: the first kit, and never a kit already the default (#507).
    set_default_brand_kit: { actions: ['save_brand_kit'], detailHas: '"madeDefault":true' },
    delete_asset: { actions: ['delete'], detailHas: '"type":"asset"' },
    delete_data_source: { actions: ['delete'], detailHas: '"type":"data_source"' },
    delete_playlist: { actions: ['delete'], detailHas: '"type":"playlist"' },
    delete_schedule_entry: { actions: ['delete'], detailHas: '"type":"schedule_entry"' },
    publish_takeover: { actions: ['takeover'], detailHas: '"action":"publish"' },
    end_takeover: { actions: ['takeover'], detailHas: '"action":"end"' },
    create_asset_upload: { actions: ['start_upload'], detailHas: '"kind":"image"' },
    create_video_upload: { actions: ['start_upload'], detailHas: '"kind":"video"' },
    finalize_asset: { actions: ['finalize_upload'], detailHas: '"kind":"image"' },
    finalize_video_upload: { actions: ['finalize_upload'], detailHas: '"kind":"video"' },
    set_slack_alert_channel: { actions: ['set_alert_channel'], detailHas: '"kind":"slack"' },
    set_webhook_alert_channel: { actions: ['set_alert_channel'], detailHas: '"kind":"webhook"' },
  };

const isoTime = z.iso.datetime({ offset: true });
/**
 * A time an agent gives as it reads one, ISO 8601, or as the CMS does, ms since the epoch (#345): ms to the handler.
 * Checked by refine, so its schema says date-time rather than carry zod's regex (#543).
 */
const instant = z.union(
  [
    z.number().int().nonnegative(),
    z
      .string()
      .refine((t) => isoTime.safeParse(t).success)
      .meta({ format: 'date-time' })
      .transform((t) => Date.parse(t)),
  ],
  { error: 'Expected an ISO 8601 time with its offset, such as 2026-11-26T09:00:00Z, or ms since the epoch' },
);

const listAuditLog = defineTool({
  name: 'list_audit_log',
  description:
    "List the changes made in the organization, newest first, a page at a time: who made each (a member, an agent, a screen or the system) and through what, the action, its target and what it was given, with secrets redacted (and an invitee's email, except for owners). Filter by actor, action, target, time and text. Reads are not recorded. Returns { entries, next }; pass next as cursor, with the same filters, for older entries.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({
    ...pageInput,
    actor: z
      .object({ kind: z.enum(ACTOR_KINDS).optional(), id: z.string().min(1).max(200).optional().describe('One actor, as an entry names it') })
      .optional()
      .describe('Only what this kind of actor, or this one actor, did'),
    action: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        'Only this action, such as update_screen. A replaced tool also finds the rows of the tool that does its job now: create_spot and update_spot find save_spot without and with spotId, delete_playlist finds delete of a playlist, identify_screen finds screen_command identify, and so on',
      ),
    target: z
      .object({ kind: z.string().min(1).max(40).describe('Such as screen or spot'), id: z.string().min(1).max(200).optional() })
      .optional()
      .describe('Only what was done to this kind of thing, or this one thing, even one since deleted'),
    from: instant.optional().describe('Only entries at or after this time: ISO 8601, or ms since the epoch'),
    to: instant.optional().describe('Only entries before this time: ISO 8601, or ms since the epoch'),
    query: z.string().trim().min(1).max(100).optional().describe('Only entries whose action, actor, target or recorded input contains this text'),
  }),
  output: outputs.list_audit_log,
  example: {},
  handler: async ({ org, input, role }) => {
    const { actor, target, action, from, to, query } = input;
    const owner = role === 'owner';
    const { rows, next } = await keysetPage(
      input,
      (after, limit) =>
        org.auditLog.page({
          limit,
          after: after && seqKey(after, org.orgId),
          actorKind: actor?.kind,
          actorId: actor?.id,
          action,
          alsoAction: action === undefined ? undefined : ALSO[action],
          targetKind: target?.kind,
          targetId: target?.id,
          from,
          to,
          query,
          hideDetailOf: owner ? undefined : INVITATIONS,
        }),
      (e) => [e.at, e.seq, org.orgId],
    );
    const entries = rows.map((e) => {
      const detail: Record<string, unknown> = e.detailJson ? JSON.parse(e.detailJson) : {};
      // Better Auth's rows hold the email in their detail; a tool's (cancel_invitation's, #321) under `detail.detail`; and a
      // drawer card's summary (`confirmed.summary`) may name it, as rows written before the card withheld it do (review of #414).
      if (!owner && INVITATIONS.includes(e.action)) {
        delete detail.email;
        const more = detail.detail;
        if (typeof more === 'object' && more !== null && !Array.isArray(more))
          detail.detail = Object.fromEntries(Object.entries(more).filter(([k]) => k !== 'email'));
        const confirmed = detail.confirmed;
        if (typeof confirmed === 'object' && confirmed !== null && !Array.isArray(confirmed))
          detail.confirmed = Object.fromEntries(Object.entries(confirmed).filter(([k]) => k !== 'summary'));
      }
      // A connection's client named itself: only as a page may show it, rows written before that rule too.
      if (e.action === 'create_agent_grant' && typeof detail.clientId === 'string' && typeof detail.clientName === 'string') {
        detail.clientName = shownClientName(detail.clientId, detail.clientName);
      }
      return {
        at: e.at,
        actor: { kind: e.actorKind, id: e.actorId, clientId: e.clientId },
        action: e.action,
        target: e.targetKind && e.targetId ? { kind: e.targetKind, id: e.targetId } : null,
        detail,
      };
    });
    return { entries, next };
  },
});

/**
 * A cursor's key as this list makes it: a time, a rowid and the org it was made in. The org is
 * refused anywhere else: the caller's org is the session's, so a member who switched org would
 * otherwise page one org's log on into another's.
 */
function seqKey(key: readonly (string | number)[], orgId: string | null): [number, number] {
  const [at, seq, org] = key;
  if (key.length === 3 && typeof at === 'number' && typeof seq === 'number' && org === orgId) return [at, seq];
  const why = key.length === 3 && typeof org === 'string' && org !== orgId ? 'it was made in another organization' : 'it is not one this list returned';
  throw new ToolError('invalid_input', `cursor cannot be used: ${why}; start again without it`, [{ path: 'cursor', message: why }]);
}

export const auditTools = [listAuditLog];
