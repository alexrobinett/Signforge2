/**
 * The Groups list (Settings, Screens & groups): renaming a group, deleting one, and choosing its
 * screens, one dialog at a time. A rename is a versioned draft of the group (./versioned-draft.ts),
 * sent with the version the list read. Members are the boxes this person changed, sent as one add
 * and one remove against the group as the page holds it then: never a replace, so a screen someone
 * else put in the group meanwhile stays, and a box left alone sends nothing. Each answer goes into
 * the list the Screens pages read (`putGroup`).
 *
 * Each dialog opened has an id. A request belongs to the dialog that sent it: its pending state and
 * refusal are that dialog's, and an answer that comes once it is closed changes nothing. While
 * a delete or Members save runs, Cancel waits for it (`cancelGroupDialog`), so a save is all or
 * nothing, and Members' checklist takes no change; a dialog closed another way before its writes
 * are sent sends none.
 */
import { orgOnScreen } from '~/lib/live';
import { isRetired } from '~/lib/screen-status';
import { ruleOf, ruleProblem, type RuleTerm } from '~/lib/rules';
import type { GroupView } from '~/lib/screen-types';
import { callTool, isConflict, Refusal, toolMessage } from '~/lib/tools';
import { scheduleKey } from '~/queries/schedule';
import { putGroup, screensQuery } from '~/queries/screens';
import { getScreenStatus } from '~/server/screens.functions';
import type { SliceCreator } from './store';
import { createVersionedDrafts, realClock, type Drafts } from './versioned-draft';

type DialogOf =
  /** `reloading`: Reload is reading the groups again; the name takes no typing until it reopens. */
  | { kind: 'rename'; reloading: boolean }
  /** `blockedBy`: the schedule entries `delete_group` was refused for, once it was. */
  | { kind: 'delete'; blockedBy: string[] }
  /** `edits`: the boxes this person changed, by screen; any other shows the group as the page holds it. */
  | { kind: 'members'; edits: Readonly<Record<string, boolean>>; query: string }
  /** A group made here (#186): a name, and its screens ticked (`edits`) or the rule that matches them (`terms`). */
  | { kind: 'new'; name: string; how: 'list' | 'rule'; edits: Readonly<Record<string, boolean>>; query: string; terms: RuleTerm[] }
  /** A smart group's rule, changed at the version the page read (#186). */
  | { kind: 'rule'; terms: RuleTerm[] };

type GroupDialog = DialogOf & {
  id: string;
  orgId: string;
  groupId: string;
  /** Its delete or members change is on its way: another is ignored. */
  pending: boolean;
  /** Why its delete or members change was refused. */
  error: string | null;
};

interface GroupsState {
  dialog: GroupDialog | null;
  /** The rename dialog's draft, at `DIALOG`. */
  renames: Drafts<{ name: string }>;
}

export interface GroupsSlice {
  groups: GroupsState;
  openGroupRename: (orgId: string, group: GroupView) => void;
  nameGroup: (name: string) => void;
  renameGroup: (orgId: string) => Promise<void>;
  /** After a conflict: reads the groups again and opens the rename on the group as it is now, unless another dialog opened meanwhile. */
  reloadGroupRename: (orgId: string) => Promise<void>;
  askToDeleteGroup: (orgId: string, groupId: string) => void;
  deleteGroup: (orgId: string) => Promise<void>;
  openGroupMembers: (orgId: string, group: GroupView) => void;
  searchGroupMembers: (query: string) => void;
  chooseGroupMember: (screenId: string, member: boolean) => void;
  /**
   * Sends the boxes changed against `group`, the group as the page holds it now: one add, one remove,
   * none for no change. A screen revoked meanwhile (its status read again first) is left as it is.
   */
  saveGroupMembers: (orgId: string, group: GroupView) => Promise<void>;
  /** "New group…": a group of listed screens or a smart group, made in one `save_group` (#186). */
  openNewGroup: (orgId: string) => void;
  typeNewGroupName: (name: string) => void;
  chooseNewGroupKind: (how: 'list' | 'rule') => void;
  createGroup: (orgId: string) => Promise<void>;
  /** "Rule…": a smart group's conditions, saved at the version the page read. */
  openGroupRule: (orgId: string, group: GroupView) => void;
  addRuleTerm: () => void;
  changeRuleTerm: (index: number, term: RuleTerm) => void;
  removeRuleTerm: (index: number) => void;
  saveGroupRule: (orgId: string, group: GroupView) => Promise<void>;
  /** Cancel, Escape or a click outside: ignored while the dialog's delete or save runs. */
  cancelGroupDialog: () => void;
  closeGroupDialog: () => void;
}

const DIALOG = 'dialog';

/** Whether the members dialog shows `screenId` ticked: as this person set it, else as `group` has it. */
export const memberChecked = (dialog: GroupDialog | null, group: Pick<GroupView, 'screenIds'>, screenId: string) =>
  (dialog?.kind === 'members' || dialog?.kind === 'new' ? dialog.edits[screenId] : undefined) ?? group.screenIds.includes(screenId);

/** The conditions the open dialog builds: the new group's, or the rule's. */
export const termsOf = (dialog: GroupDialog | null): RuleTerm[] => (dialog?.kind === 'rule' || dialog?.kind === 'new' ? dialog.terms : []);

/** A condition just added: a key and value still to choose. */
const BLANK: RuleTerm = { key: '', op: 'eq', values: [] };

/** The schedule entries a refused `delete_group` names (packages/tools/src/groups.ts). */
function blockingEntries(err: unknown): string[] {
  if (!(err instanceof Refusal) || !isConflict(err)) return [];
  const d: unknown = err.details;
  const ids = typeof d === 'object' && d !== null && 'scheduleEntryIds' in d ? d.scheduleEntryIds : null;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

/** The dialog with its conditions changed, and its last refusal cleared, which may have been about them. */
const withTerms = (d: GroupDialog, change: (terms: RuleTerm[]) => RuleTerm[]): GroupDialog =>
  d.kind === 'rule' || d.kind === 'new' ? { ...d, terms: change(d.terms), error: null } : d;

export const createGroupsSlice: SliceCreator<GroupsSlice> = (set, get, { router, queryClient }) => {
  const patch = (fn: (s: GroupsState) => GroupsState) => set((s) => ({ groups: fn(s.groups) }));
  const dialog = () => get().groups.dialog;
  /** Changes the dialog `id`, if it is still the one open. */
  const onDialog = (id: string, fn: (d: GroupDialog) => GroupDialog | null) => patch((s) => (s.dialog?.id === id ? { ...s, dialog: fn(s.dialog) } : s));

  const renames = createVersionedDrafts<{ name: string }>({
    makeId: () => crypto.randomUUID(),
    currentOrg: () => orgOnScreen(router),
    clock: realClock,
    state: { read: () => get().groups.renames, write: (change) => patch((s) => ({ ...s, renames: change(s.renames) })) },
    async save({ draft: { orgId, record, edit, version } }) {
      const out = await callTool('save_group', { groupId: record, name: edit.name.trim(), ifVersion: version });
      putGroup(queryClient, orgId, out.group);
      return { version: out.group.version };
    },
  });

  /** Runs the dialog's delete or members change, unless one is running; it closes once done, and keeps a refusal to show. */
  async function run(d: GroupDialog, send: () => Promise<void>, refused: (x: GroupDialog, err: unknown) => GroupDialog = (x) => x) {
    if (d.pending) return;
    onDialog(d.id, (x) => ({ ...x, pending: true, error: null }));
    try {
      await send();
      onDialog(d.id, () => null);
    } catch (err) {
      onDialog(d.id, (x) => ({ ...refused(x, err), pending: false, error: toolMessage(err) }));
    }
  }

  const open = (orgId: string, groupId: string, of: DialogOf) => {
    renames.drop(DIALOG);
    patch((s) => ({ ...s, dialog: { ...of, id: crypto.randomUUID(), orgId, groupId, pending: false, error: null } }));
  };

  return {
    groups: { dialog: null, renames: {} },

    openGroupRename(orgId, group) {
      open(orgId, group.id, { kind: 'rename', reloading: false });
      renames.open(DIALOG, { orgId, record: group.id, version: group.version, edit: { name: group.name } });
    },
    nameGroup: (name) => {
      const d = dialog();
      if (d?.kind === 'rename' && !d.reloading) renames.update(DIALOG, () => ({ name }));
    },
    async renameGroup(orgId) {
      const d = get().groups.renames[DIALOG];
      if (d?.orgId !== orgId) return;
      const saved = await renames.save(DIALOG);
      if (saved?.status === 'saved' && get().groups.renames[DIALOG]?.id === saved.id) get().closeGroupDialog();
    },
    async reloadGroupRename(orgId) {
      const d = dialog();
      if (d?.kind !== 'rename' || d.reloading || d.orgId !== orgId) return;
      onDialog(d.id, (x) => (x.kind === 'rename' ? { ...x, reloading: true } : x));
      await queryClient.invalidateQueries({ queryKey: screensQuery(orgId).queryKey, exact: true });
      // Dismissed or replaced meanwhile: that was the person's answer.
      const now = queryClient.getQueryData(screensQuery(orgId).queryKey)?.groups.find((g) => g.id === d.groupId);
      if (dialog()?.id !== d.id) return;
      if (now) get().openGroupRename(orgId, now);
      else onDialog(d.id, (x) => (x.kind === 'rename' ? { ...x, reloading: false } : x));
    },

    askToDeleteGroup: (orgId, groupId) => open(orgId, groupId, { kind: 'delete', blockedBy: [] }),
    async deleteGroup(orgId) {
      const d = dialog();
      if (d?.kind !== 'delete' || d.orgId !== orgId) return;
      await run(
        d,
        async () => {
          putGroup(queryClient, orgId, await callTool('delete_group', { groupId: d.groupId }));
          // A brand kit the group chose is no longer chosen by it.
          await queryClient.invalidateQueries({ queryKey: ['org', orgId, 'brandKits'] });
        },
        (x, err) => {
          // The entries named may be newer than the list the page read: it reads them again, to name them.
          void queryClient.invalidateQueries({ queryKey: scheduleKey(orgId) });
          return x.kind === 'delete' ? { ...x, blockedBy: blockingEntries(err) } : x;
        },
      );
    },

    openGroupMembers: (orgId, group) => open(orgId, group.id, { kind: 'members', edits: {}, query: '' }),
    searchGroupMembers: (query) => patch((s) => (s.dialog?.kind === 'members' || s.dialog?.kind === 'new' ? { ...s, dialog: { ...s.dialog, query } } : s)),
    chooseGroupMember: (screenId, member) =>
      patch((s) =>
        (s.dialog?.kind === 'members' || s.dialog?.kind === 'new') && !s.dialog.pending
          ? { ...s, dialog: { ...s.dialog, edits: { ...s.dialog.edits, [screenId]: member } } }
          : s,
      ),
    async saveGroupMembers(orgId, group) {
      const d = dialog();
      if (d?.kind !== 'members' || d.orgId !== orgId) return;
      const edits = Object.entries(d.edits).filter(([id, member]) => member !== group.screenIds.includes(id));
      if (!edits.length) return get().closeGroupDialog();
      await run(d, async () => {
        // Revoked since the page read it? Then it is retired: left as it is, never taken out of the
        // group. Read now, not from the poll's cache, which can join a poll from before the revoke.
        const now = await getScreenStatus();
        const retired = new Set(now.screens.filter(isRetired).map((s) => s.id));
        const of = (member: boolean) => edits.filter(([id, m]) => m === member && !retired.has(id)).map(([id]) => id);
        const add = of(true);
        const remove = of(false);
        // Closed meanwhile (Cancel): nothing is sent. The removal goes first, closest to that read.
        if (dialog()?.id !== d.id) return;
        if (remove.length) putGroup(queryClient, orgId, (await callTool('save_group', { groupId: group.id, screenIds: remove, membership: 'remove' })).group);
        if (add.length && dialog()?.id === d.id)
          putGroup(queryClient, orgId, (await callTool('save_group', { groupId: group.id, screenIds: add, membership: 'add' })).group);
      });
    },

    openNewGroup: (orgId) => open(orgId, '', { kind: 'new', name: '', how: 'list', edits: {}, query: '', terms: [BLANK] }),
    typeNewGroupName: (name) => patch((s) => (s.dialog?.kind === 'new' && !s.dialog.pending ? { ...s, dialog: { ...s.dialog, name, error: null } } : s)),
    chooseNewGroupKind: (how) => patch((s) => (s.dialog?.kind === 'new' && !s.dialog.pending ? { ...s, dialog: { ...s.dialog, how, error: null } } : s)),
    async createGroup(orgId) {
      const d = dialog();
      if (d?.kind !== 'new' || d.orgId !== orgId) return;
      const name = d.name.trim();
      if (!name) return onDialog(d.id, (x) => ({ ...x, error: 'Name the group.' }));
      const problem = d.how === 'rule' ? ruleProblem(d.terms) : undefined;
      if (problem) return onDialog(d.id, (x) => ({ ...x, error: problem }));
      const screenIds = Object.entries(d.edits).flatMap(([id, member]) => (member ? [id] : []));
      await run(d, async () => {
        // The dialog's id is the call's key: a retry after a lost answer makes no second group.
        await callTool('save_group', { name, idempotencyKey: d.id, ...(d.how === 'rule' ? { selector: ruleOf(d.terms) } : { screenIds }) });
        await queryClient.invalidateQueries({ queryKey: screensQuery(orgId).queryKey, exact: true });
      });
    },

    openGroupRule: (orgId, group) =>
      open(orgId, group.id, { kind: 'rule', terms: group.selector ? group.selector.all.map((t) => ({ ...t, values: [...t.values] })) : [BLANK] }),
    addRuleTerm: () => patch((s) => (s.dialog && !s.dialog.pending ? { ...s, dialog: withTerms(s.dialog, (t) => [...t, BLANK]) } : s)),
    changeRuleTerm: (index, term) =>
      patch((s) => (s.dialog && !s.dialog.pending ? { ...s, dialog: withTerms(s.dialog, (t) => t.map((x, i) => (i === index ? term : x))) } : s)),
    removeRuleTerm: (index) =>
      patch((s) => (s.dialog && !s.dialog.pending ? { ...s, dialog: withTerms(s.dialog, (t) => t.filter((_, i) => i !== index)) } : s)),
    async saveGroupRule(orgId, group) {
      const d = dialog();
      if (d?.kind !== 'rule' || d.orgId !== orgId) return;
      const problem = ruleProblem(d.terms);
      if (problem) return onDialog(d.id, (x) => ({ ...x, error: problem }));
      await run(d, async () => {
        putGroup(queryClient, orgId, (await callTool('save_group', { groupId: group.id, selector: ruleOf(d.terms), ifVersion: group.version })).group);
      });
    },

    cancelGroupDialog() {
      if (!dialog()?.pending) get().closeGroupDialog();
    },

    closeGroupDialog() {
      renames.drop(DIALOG);
      patch((s) => ({ ...s, dialog: null }));
    },
  };
};
