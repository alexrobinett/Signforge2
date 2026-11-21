// The Groups list in the store (#183): rename (a versioned draft), delete (refused while entries
// target the group, with them shown) and members (added and removed, never replaced). Tool calls
// go to a stubbed `callTool` the test answers in turn; nothing waits on a clock.
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { GroupView } from '../src/lib/screen-types';
import { Refusal } from '../src/lib/tools';
import { screensQuery } from '../src/queries/screens';
import { getScreenStatus } from '../src/server/screens.functions';
import { createGroupsSlice, memberChecked, type GroupsSlice } from '../src/state/groups';

/** The tool calls the store makes, answered in turn by the test. */
const callTool = vi.fn();
vi.mock('~/lib/tools', async (actual) => ({ ...(await actual<object>()), callTool: (name: string, input: unknown) => callTool(name, input) }));
vi.mock('~/server/screens.functions', () => ({ getScreens: vi.fn(), getScreenStatus: vi.fn() }));
vi.mock('~/server/schedule.functions', () => ({ getSchedule: vi.fn() }));

const ORG = 'org_1';
const front: GroupView = { id: 'grp_front', name: 'Front', screenIds: ['scr_1', 'scr_old'], version: 4, createdAt: 0, updatedAt: 0 };
const router = { state: { matches: [{ routeId: '/_app', loaderData: { organization: { id: ORG } } }] } };
const calls = () => callTool.mock.calls.map(([name, input]: unknown[]) => ({ name, input }));
const answer = (out: unknown) => callTool.mockResolvedValueOnce(out);
const refuse = (code: 'conflict' | 'not_found', message: string, details?: unknown) => callTool.mockRejectedValueOnce(new Refusal(code, message, details));

function groupsStore() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(screensQuery(ORG).queryKey, { screens: [], groups: [front], at: 0 });
  const store = createStore<GroupsSlice>()((set, get) => createGroupsSlice(set as never, get as never, { router, queryClient } as never));
  const groups = () => queryClient.getQueryData(screensQuery(ORG).queryKey)?.groups;
  return { store, groups };
}

/** What `list_screen_status` says of each screen: active, unless named revoked. */
function status(...revoked: string[]) {
  const state = (id: string) => ({
    kind: revoked.includes(id) ? 'needs_you' : 'online',
    reason: revoked.includes(id) ? 'revoked' : null,
    wakesAt: null,
    filesMissing: null,
  });
  const ids = ['scr_1', 'scr_2', 'scr_3', 'scr_9', 'scr_old'];
  vi.mocked(getScreenStatus).mockResolvedValue({
    screens: ids.map((id) => ({ id, state: state(id), lastSeenAt: null, desiredManifestId: null, reportedManifestId: null })),
    at: 1,
  } as never);
}

/** A tool call the test answers later. */
function held() {
  let settle: { answer: (out: unknown) => void; refuse: (err: Refusal) => void } = { answer: () => {}, refuse: () => {} };
  callTool.mockReturnValueOnce(new Promise((answer, refuse) => (settle = { answer, refuse })));
  return settle;
}

beforeEach(() => {
  callTool.mockReset();
  status('scr_old');
});

describe('rename', () => {
  it('sends the version the list read, puts the answer in the list and closes', async () => {
    const { store, groups } = groupsStore();
    store.getState().openGroupRename(ORG, front);
    store.getState().nameGroup('Front of house');
    answer({ group: { ...front, name: 'Front of house', version: 5 } });
    await store.getState().renameGroup(ORG);
    expect(calls()).toEqual([{ name: 'rename_group', input: { groupId: 'grp_front', name: 'Front of house', ifVersion: 4 } }]);
    expect(groups()?.[0]).toMatchObject({ name: 'Front of house', version: 5 });
    expect(store.getState().groups.dialog).toBeNull();
  });

  it('a change made since is refused: the name typed stays, with Reload, and nothing more is sent', async () => {
    const { store } = groupsStore();
    store.getState().openGroupRename(ORG, front);
    store.getState().nameGroup('Front of house');
    refuse('conflict', 'stale', { version: 5 });
    await store.getState().renameGroup(ORG);
    expect(store.getState().groups.renames.dialog).toMatchObject({ stale: true, edit: { name: 'Front of house' }, error: 'This changed since you opened it.' });
    await store.getState().renameGroup(ORG);
    expect(calls()).toHaveLength(1);
  });

  it('Reload after a conflict leaves alone a dialog opened while it read the groups again (review of #205)', async () => {
    const { store } = groupsStore();
    store.getState().openGroupRename(ORG, front);
    refuse('conflict', 'stale', { version: 5 });
    await store.getState().renameGroup(ORG);
    const reloading = store.getState().reloadGroupRename(ORG);
    store.getState().askToDeleteGroup(ORG, front.id);
    await reloading;
    expect(store.getState().groups.dialog).toMatchObject({ kind: 'delete' });
  });
});

describe('delete', () => {
  it('refused while entries target the group: the dialog stays open with them, and the group stays', async () => {
    const { store, groups } = groupsStore();
    store.getState().askToDeleteGroup(ORG, front.id);
    refuse('conflict', 'group grp_front is targeted by 1 schedule entries', { scheduleEntryIds: ['sch_1'] });
    await store.getState().deleteGroup(ORG);
    expect(store.getState().groups.dialog).toMatchObject({
      kind: 'delete',
      groupId: front.id,
      blockedBy: ['sch_1'],
      pending: false,
      error: 'group grp_front is targeted by 1 schedule entries',
    });
    expect(groups()).toHaveLength(1);
  });

  it('takes the group off the list once deleted', async () => {
    const { store, groups } = groupsStore();
    store.getState().askToDeleteGroup(ORG, front.id);
    answer({ deleted: front.id });
    await store.getState().deleteGroup(ORG);
    expect(calls()).toEqual([{ name: 'delete_group', input: { groupId: front.id } }]);
    expect(groups()).toEqual([]);
    expect(store.getState().groups.dialog).toBeNull();
  });

  it('a late answer to a delete whose dialog was closed leaves the dialog opened since, and its typed name, alone (review of #205)', async () => {
    const { store } = groupsStore();
    store.getState().askToDeleteGroup(ORG, front.id);
    const call = held();
    const deleting = store.getState().deleteGroup(ORG);
    store.getState().closeGroupDialog();
    store.getState().openGroupRename(ORG, { ...front, id: 'grp_back', name: 'Back' });
    store.getState().nameGroup('Back of house');
    call.answer({ deleted: front.id });
    await deleting;
    expect(store.getState().groups.dialog).toMatchObject({ kind: 'rename', groupId: 'grp_back', pending: false });
    expect(store.getState().groups.renames.dialog?.edit.name).toBe('Back of house');
  });

  it('a late refusal of a delete does not bring its dialog back over the one opened since (review of #205)', async () => {
    const { store } = groupsStore();
    store.getState().askToDeleteGroup(ORG, front.id);
    const call = held();
    const deleting = store.getState().deleteGroup(ORG);
    store.getState().closeGroupDialog();
    store.getState().openGroupMembers(ORG, front);
    call.refuse(new Refusal('conflict', 'targeted', { scheduleEntryIds: ['sch_1'] }));
    await deleting;
    expect(store.getState().groups.dialog).toMatchObject({ kind: 'members', error: null, pending: false });
  });
});

describe('members', () => {
  it('sends only the boxes changed: one add, one remove', async () => {
    const { store, groups } = groupsStore();
    store.getState().openGroupMembers(ORG, front);
    store.getState().chooseGroupMember('scr_1', false);
    store.getState().chooseGroupMember('scr_2', true);
    store.getState().chooseGroupMember('scr_3', true);
    answer({ group: { ...front, screenIds: ['scr_1', 'scr_2', 'scr_3', 'scr_old'], version: 5 } });
    answer({ group: { ...front, screenIds: ['scr_2', 'scr_3', 'scr_old'], version: 6 } });
    await store.getState().saveGroupMembers(ORG, front);
    expect(calls()).toEqual([
      { name: 'add_group_members', input: { groupId: front.id, screenIds: ['scr_2', 'scr_3'] } },
      { name: 'remove_group_members', input: { groupId: front.id, screenIds: ['scr_1'] } },
    ]);
    expect(groups()?.[0]).toMatchObject({ screenIds: ['scr_2', 'scr_3', 'scr_old'], version: 6 });
    expect(store.getState().groups.dialog).toBeNull();
  });

  it('saved untouched after the list was read again, removes nothing another editor added (review of #205)', async () => {
    const { store } = groupsStore();
    store.getState().openGroupMembers(ORG, front);
    // Someone else added scr_9; the page read the group again.
    const now = { ...front, screenIds: ['scr_1', 'scr_9', 'scr_old'], version: 5 };
    const dialog = store.getState().groups.dialog;
    expect(memberChecked(dialog, now, 'scr_9')).toBe(true);
    await store.getState().saveGroupMembers(ORG, now);
    expect(calls()).toEqual([]);

    // An edit of one box sends that box only.
    store.getState().openGroupMembers(ORG, front);
    store.getState().chooseGroupMember('scr_1', false);
    answer({ group: { ...now, screenIds: ['scr_9', 'scr_old'], version: 6 } });
    await store.getState().saveGroupMembers(ORG, now);
    expect(calls()).toEqual([{ name: 'remove_group_members', input: { groupId: front.id, screenIds: ['scr_1'] } }]);
  });

  it('never removes a screen revoked while the dialog was open: its status is read again before the call (review of #205)', async () => {
    const { store } = groupsStore();
    store.getState().openGroupMembers(ORG, front);
    store.getState().chooseGroupMember('scr_1', false);
    store.getState().chooseGroupMember('scr_2', true);
    status('scr_old', 'scr_1');
    answer({ group: { ...front, screenIds: ['scr_1', 'scr_2', 'scr_old'], version: 5 } });
    await store.getState().saveGroupMembers(ORG, front);
    expect(calls()).toEqual([{ name: 'add_group_members', input: { groupId: front.id, screenIds: ['scr_2'] } }]);
  });

  it('with nothing changed, sends nothing and closes', async () => {
    const { store } = groupsStore();
    store.getState().openGroupMembers(ORG, front);
    store.getState().searchGroupMembers('lobby');
    expect(store.getState().groups.dialog).toMatchObject({ query: 'lobby' });
    await store.getState().saveGroupMembers(ORG, front);
    expect(calls()).toEqual([]);
    expect(store.getState().groups.dialog).toBeNull();
  });

  it('a refusal keeps the dialog open with what was ticked, and says why', async () => {
    const { store } = groupsStore();
    store.getState().openGroupMembers(ORG, front);
    store.getState().chooseGroupMember('scr_2', true);
    refuse('not_found', 'screen scr_2 not found');
    await store.getState().saveGroupMembers(ORG, front);
    const dialog = store.getState().groups.dialog;
    expect(dialog).toMatchObject({ kind: 'members', error: 'screen scr_2 not found', pending: false });
    expect(['scr_1', 'scr_2', 'scr_3'].map((id) => memberChecked(dialog, front, id))).toEqual([true, true, false]);
  });
});
