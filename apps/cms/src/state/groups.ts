/**
 * The Groups list (Settings, Screens & groups): renaming a group, deleting one, and choosing its
 * screens, one dialog at a time. A rename is a versioned draft of the group (./versioned-draft.ts),
 * sent with the version the list read. Members are added and removed, never replaced, so a screen
 * someone else put in the group meanwhile stays, and so does one the picker does not offer (a
 * retired screen). Each answer goes into the list the Screens pages read (`putGroup`).
 */
import { orgOnScreen } from '~/lib/live';
import type { GroupView } from '~/lib/screen-types';
import { callTool, isConflict, Refusal, toolMessage } from '~/lib/tools';
import { scheduleKey } from '~/queries/schedule';
import { putGroup, screensQuery } from '~/queries/screens';
import type { SliceCreator } from './store';
import { createVersionedDrafts, realClock, type Drafts } from './versioned-draft';

type GroupDialog =
  | { kind: 'rename'; orgId: string; groupId: string }
  /** `blockedBy`: the schedule entries `delete_group` was refused for, once it was. */
  | { kind: 'delete'; orgId: string; groupId: string; blockedBy: string[] }
  | { kind: 'members'; orgId: string; groupId: string; chosen: string[]; query: string };

interface GroupsState {
  dialog: GroupDialog | null;
  /** A delete or a members change is on its way: another is ignored. */
  pending: boolean;
  /** Why the last delete or members change was refused. */
  error: string | null;
  /** The rename dialog's draft, at `DIALOG`. */
  renames: Drafts<{ name: string }>;
}

export interface GroupsSlice {
  groups: GroupsState;
  openGroupRename: (orgId: string, group: GroupView) => void;
  nameGroup: (name: string) => void;
  renameGroup: (orgId: string) => Promise<void>;
  /** After a conflict: reads the groups again and opens the rename on the group as it is now. */
  reloadGroupRename: (orgId: string) => Promise<void>;
  askToDeleteGroup: (orgId: string, groupId: string) => void;
  deleteGroup: (orgId: string) => Promise<void>;
  /** Opens the members picker; `pickable` are the screens it offers. */
  openGroupMembers: (orgId: string, group: GroupView, pickable: string[]) => void;
  searchGroupMembers: (query: string) => void;
  chooseGroupMember: (screenId: string, member: boolean) => void;
  /** Adds the screens ticked and removes those unticked, of the ones `pickable`: one call each, none for no change. */
  saveGroupMembers: (orgId: string, group: GroupView, pickable: string[]) => Promise<void>;
  closeGroupDialog: () => void;
}

const DIALOG = 'dialog';

/** The schedule entries a refused `delete_group` names (packages/tools/src/groups.ts). */
function blockingEntries(err: unknown): string[] {
  if (!(err instanceof Refusal) || !isConflict(err)) return [];
  const d: unknown = err.details;
  const ids = typeof d === 'object' && d !== null && 'scheduleEntryIds' in d ? d.scheduleEntryIds : null;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

export const createGroupsSlice: SliceCreator<GroupsSlice> = (set, get, { router, queryClient }) => {
  const patch = (fn: (s: GroupsState) => GroupsState) => set((s) => ({ groups: fn(s.groups) }));
  const dialog = () => get().groups.dialog;
  const here = (orgId: string) => orgOnScreen(router) === orgId;

  const renames = createVersionedDrafts<{ name: string }>({
    makeId: () => crypto.randomUUID(),
    currentOrg: () => orgOnScreen(router),
    clock: realClock,
    state: { read: () => get().groups.renames, write: (change) => patch((s) => ({ ...s, renames: change(s.renames) })) },
    async save({ draft: { orgId, record, edit, version } }) {
      const out = await callTool('rename_group', { groupId: record, name: edit.name.trim(), ifVersion: version });
      putGroup(queryClient, orgId, out.group);
      return { version: out.group.version };
    },
  });

  /** Runs a delete or a members change, unless one is running; a refusal is kept to show. */
  async function run(orgId: string, send: () => Promise<void>, refused?: (err: unknown) => void) {
    if (get().groups.pending) return;
    patch((s) => ({ ...s, pending: true, error: null }));
    try {
      await send();
      if (here(orgId)) patch((s) => ({ ...s, dialog: null }));
    } catch (err) {
      if (here(orgId)) {
        refused?.(err);
        patch((s) => ({ ...s, error: toolMessage(err) }));
      }
    } finally {
      patch((s) => ({ ...s, pending: false }));
    }
  }

  const open = (next: GroupDialog) => {
    renames.drop(DIALOG);
    patch((s) => ({ ...s, dialog: next, pending: false, error: null }));
  };

  return {
    groups: { dialog: null, pending: false, error: null, renames: {} },

    openGroupRename(orgId, group) {
      open({ kind: 'rename', orgId, groupId: group.id });
      renames.open(DIALOG, { orgId, record: group.id, version: group.version, edit: { name: group.name } });
    },
    nameGroup: (name) => renames.update(DIALOG, () => ({ name })),
    async renameGroup(orgId) {
      const d = get().groups.renames[DIALOG];
      if (d?.orgId !== orgId) return;
      const saved = await renames.save(DIALOG);
      if (saved?.status === 'saved' && get().groups.renames[DIALOG]?.id === saved.id) get().closeGroupDialog();
    },
    async reloadGroupRename(orgId) {
      const groupId = dialog()?.groupId;
      get().closeGroupDialog();
      await queryClient.invalidateQueries({ queryKey: screensQuery(orgId).queryKey, exact: true });
      const now = queryClient.getQueryData(screensQuery(orgId).queryKey)?.groups.find((g) => g.id === groupId);
      if (now && here(orgId)) get().openGroupRename(orgId, now);
    },

    askToDeleteGroup: (orgId, groupId) => open({ kind: 'delete', orgId, groupId, blockedBy: [] }),
    async deleteGroup(orgId) {
      const d = dialog();
      if (d?.kind !== 'delete' || d.orgId !== orgId) return;
      await run(
        orgId,
        async () => {
          putGroup(queryClient, orgId, await callTool('delete_group', { groupId: d.groupId }));
          // A brand kit the group chose is no longer chosen by it.
          await queryClient.invalidateQueries({ queryKey: ['org', orgId, 'brandKits'] });
        },
        (err) => {
          patch((s) => ({ ...s, dialog: { ...d, blockedBy: blockingEntries(err) } }));
          // The entries named may be newer than the list the page read: it reads them again, to name them.
          void queryClient.invalidateQueries({ queryKey: scheduleKey(orgId) });
        },
      );
    },

    openGroupMembers: (orgId, group, pickable) =>
      open({ kind: 'members', orgId, groupId: group.id, chosen: group.screenIds.filter((id) => pickable.includes(id)), query: '' }),
    searchGroupMembers: (query) => patch((s) => (s.dialog?.kind === 'members' ? { ...s, dialog: { ...s.dialog, query } } : s)),
    chooseGroupMember: (screenId, member) =>
      patch((s) =>
        s.dialog?.kind === 'members'
          ? { ...s, dialog: { ...s.dialog, chosen: member ? [...new Set([...s.dialog.chosen, screenId])] : s.dialog.chosen.filter((id) => id !== screenId) } }
          : s,
      ),
    async saveGroupMembers(orgId, group, pickable) {
      const d = dialog();
      if (d?.kind !== 'members' || d.orgId !== orgId) return;
      const add = d.chosen.filter((id) => !group.screenIds.includes(id));
      const remove = group.screenIds.filter((id) => pickable.includes(id) && !d.chosen.includes(id));
      await run(orgId, async () => {
        if (add.length) putGroup(queryClient, orgId, (await callTool('add_group_members', { groupId: group.id, screenIds: add })).group);
        if (remove.length) putGroup(queryClient, orgId, (await callTool('remove_group_members', { groupId: group.id, screenIds: remove })).group);
      });
    },

    closeGroupDialog() {
      renames.drop(DIALOG);
      patch((s) => ({ ...s, dialog: null, pending: false, error: null }));
    },
  };
};
