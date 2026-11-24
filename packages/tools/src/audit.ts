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
    action: z.string().min(1).max(64).optional().describe('Only this action, such as rename_screen'),
    target: z
      .object({ kind: z.string().min(1).max(40).describe('Such as screen or spot'), id: z.string().min(1).max(200).optional() })
      .optional()
      .describe('Only what was done to this kind of thing, or this one thing, even one since deleted'),
    from: z.number().int().nonnegative().optional().describe('Only entries at or after this time, in ms'),
    to: z.number().int().nonnegative().optional().describe('Only entries before this time, in ms'),
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
      if (!owner && INVITATIONS.includes(e.action)) delete detail.email;
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
