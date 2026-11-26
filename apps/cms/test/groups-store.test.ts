// The Groups list in the store (#183): rename (a versioned draft), delete (refused while entries
// target the group, with them shown) and members (added and removed, never replaced). Tool calls
// go to a stubbed `callTool` the test answers in turn; nothing waits on a clock.
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { GroupView } from '../src/lib/screen-types';
import { Refusal } from '../src/lib/tools';
import { screensQuery, screenStatusQuery } from '../src/queries/screens';
import { getScreens, getScreenStatus } from '../src/server/screens.functions';
import { createGroupsSlice, memberChecked, type GroupsSlice } from '../src/state/groups';

/** The tool calls the store makes, answered in turn by the test. */
const callTool = vi.fn();
vi.mock('~/lib/tools', async (actual) => ({ ...(await actual<object>()), callTool: (name: string, input: unknown) => callTool(name, input) }));
vi.mock('~/server/screens.functions', () => ({ getScreens: vi.fn(), getScreenStatus: vi.fn() }));
vi.mock('~/server/schedule.functions', () => ({ getSchedule: vi.fn() }));

const ORG = 'org_1';
const front: GroupView = { id: 'grp_front', name: 'Front', screenIds: ['scr_1', 'scr_old'], selector: null, version: 4, createdAt: 0, updatedAt: 0 };
const router = { state: { matches: [{ routeId: '/_app', loaderData: { organization: { id: ORG } } }] } };
const calls = () => callTool.mock.calls.map(([name, input]: unknown[]) => ({ name, input }));
const answer = (out: unknown) => callTool.mockResolvedValueOnce(out);
const refuse = (code: 'conflict' | 'not_found', message: string, details?: unknown) => callTool.mockRejectedValueOnce(new Refusal(code, message, details));

function groupsStore() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(screensQuery(ORG).queryKey, { screens: [], groups: [front], at: 0 });
  const store = createStore<GroupsSlice>()((set, get) => createGroupsSlice(set as never, get as never, { router, queryClient } as never));
  const groups = () => queryClient.getQueryData(screensQuery(ORG).queryKey)?.groups;
  return { store, groups, queryClient };
}

/** What `list_screen_status` says of each screen: active, unless named revoked. */
function status(...revoked: string[]) {
  vi.mocked(getScreenStatus).mockResolvedValue(statusOf(...revoked));
}

function statusOf(...revoked: string[]) {
  const state = (id: string) => ({
    kind: revoked.includes(id) ? 'needs_you' : 'online',
    reason: revoked.includes(id) ? 'revoked' : null,
    wakesAt: null,
    filesMissing: null,
  });
  const ids = ['scr_1', 'scr_2', 'scr_3', 'scr_9', 'scr_old'];
  return {
    screens: ids.map((id) => ({ id, state: state(id), lastSeenAt: null, desiredManifestId: null, reportedManifestId: null })),
    at: 1,
  } as never;
}

/** A status read the test answers later. */
function heldStatus() {
  let release: () => void = () => {};
  vi.mocked(getScreenStatus).mockReturnValueOnce(new Promise((resolve) => (release = () => resolve(statusOf('scr_old')))));
  return () => release();
}

/** A tool call the test answers later; `called` settles once the store has made it. */
function held() {
  let settle: { answer: (out: unknown) => void; refuse: (err: Refusal) => void } = { answer: () => {}, refuse: () => {} };
  let made: () => void = () => {};
  const called = new Promise<void>((resolve) => (made = resolve));
  callTool.mockImplementationOnce(() => {
    made();
    return new Promise((answer, refuse) => (settle = { answer, refuse }));
  });
  return { ...settle, answer: (out: unknown) => settle.answer(out), refuse: (err: Refusal) => settle.refuse(err), called };
}

type Store = ReturnType<typeof groupsStore>['store'];

/** A rename refused as stale, then Reload started: what is done meanwhile, then where it leaves the dialog. */
async function reloadAround(store: Store, meanwhile: () => void) {
  store.getState().openGroupRename(ORG, front);
  refuse('conflict', 'stale', { version: 5 });
  await store.getState().renameGroup(ORG);
  const reloading = store.getState().reloadGroupRename(ORG);
  meanwhile();
  await reloading;
  return store.getState().groups.dialog;
}

/** Members with `edits` (by default scr_2 ticked), saved while its status read waits: what is done meanwhile, then the calls made. */
async function saveAround(store: Store, meanwhile: () => void, edits: Record<string, boolean> = { scr_2: true }) {
  store.getState().openGroupMembers(ORG, front);
  for (const [id, member] of Object.entries(edits)) store.getState().chooseGroupMember(id, member);
  const release = heldStatus();
  const saving = store.getState().saveGroupMembers(ORG, front);
  meanwhile();
  release();
  await saving;
  return calls();
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
    expect(calls()).toEqual([{ name: 'save_group', input: { groupId: 'grp_front', name: 'Front of house', ifVersion: 4 } }]);
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
    expect(await reloadAround(store, () => store.getState().askToDeleteGroup(ORG, front.id))).toMatchObject({ kind: 'delete' });
  });

  it('Reload does not reopen a rename dismissed while it read the groups again, even with no dialog open since (re-check of #205)', async () => {
    const { store } = groupsStore();
    const dialog = await reloadAround(store, () => {
      store.getState().closeGroupDialog();
      store.getState().openGroupMembers(ORG, front);
      store.getState().closeGroupDialog();
    });
    expect(dialog).toBeNull();
  });

  it('Reload says it is working, and the name takes no typing until it reopens on what is there now (follow-up to #205)', async () => {
    const { store, queryClient } = groupsStore();
    // The page reads the list, so Reload reads it again; its answer waits for the test.
    const unsubscribe = new QueryObserver(queryClient, screensQuery(ORG)).subscribe(() => {});
    let release: () => void = () => {};
    vi.mocked(getScreens).mockReturnValueOnce(
      new Promise((resolve) => (release = () => resolve({ screens: [], groups: [{ ...front, name: 'Front of store', version: 5 }], at: 1 } as never))),
    );
    const dialog = await reloadAround(store, () => {
      expect(store.getState().groups.dialog).toMatchObject({ kind: 'rename', reloading: true });
      store.getState().nameGroup('Typed meanwhile');
      expect(store.getState().groups.renames.dialog?.edit.name).toBe('Front');
      release();
    });
    unsubscribe();
    expect(dialog).toMatchObject({ kind: 'rename', reloading: false });
    expect(store.getState().groups.renames.dialog).toMatchObject({ version: 5, edit: { name: 'Front of store' } });
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
    answer({ group: { ...front, screenIds: ['scr_old'], version: 5 } });
    answer({ group: { ...front, screenIds: ['scr_2', 'scr_3', 'scr_old'], version: 6 } });
    await store.getState().saveGroupMembers(ORG, front);
    // The removal first, straight after the status read that cleared it.
    expect(calls()).toEqual([
      { name: 'save_group', input: { groupId: front.id, screenIds: ['scr_1'], membership: 'remove' } },
      { name: 'save_group', input: { groupId: front.id, screenIds: ['scr_2', 'scr_3'], membership: 'add' } },
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
    expect(calls()).toEqual([{ name: 'save_group', input: { groupId: front.id, screenIds: ['scr_1'], membership: 'remove' } }]);
  });

  it('never removes a screen revoked while the dialog was open: its status is read again before the call (review of #205)', async () => {
    const { store } = groupsStore();
    store.getState().openGroupMembers(ORG, front);
    store.getState().chooseGroupMember('scr_1', false);
    store.getState().chooseGroupMember('scr_2', true);
    status('scr_old', 'scr_1');
    answer({ group: { ...front, screenIds: ['scr_1', 'scr_2', 'scr_old'], version: 5 } });
    await store.getState().saveGroupMembers(ORG, front);
    expect(calls()).toEqual([{ name: 'save_group', input: { groupId: front.id, screenIds: ['scr_2'], membership: 'add' } }]);
  });

  it('Save reads status afresh: a poll already on its way, from before a revoke, is not what it goes by (re-check of #205)', async () => {
    const { store, queryClient } = groupsStore();
    store.getState().openGroupMembers(ORG, front);
    store.getState().chooseGroupMember('scr_1', false);
    // A poll started before the revoke, still on its way when Save is pressed.
    const release = heldStatus();
    const polling = queryClient.query({ ...screenStatusQuery(ORG), staleTime: 0 });
    status('scr_old', 'scr_1');
    const saving = store.getState().saveGroupMembers(ORG, front);
    release();
    await Promise.all([polling, saving]);
    expect(calls()).toEqual([]);
  });

  it('a box changed while Save runs is not taken: the checklist waits for the answer (re-check of #205)', async () => {
    const { store } = groupsStore();
    answer({ group: { ...front, screenIds: ['scr_1', 'scr_2', 'scr_old'], version: 5 } });
    const sent = await saveAround(store, () => {
      store.getState().chooseGroupMember('scr_3', true);
      expect(memberChecked(store.getState().groups.dialog, front, 'scr_3')).toBe(false);
    });
    expect(sent).toEqual([{ name: 'save_group', input: { groupId: front.id, screenIds: ['scr_2'], membership: 'add' } }]);
  });

  it('Cancel while Save reads status sends nothing (re-check of #205)', async () => {
    const { store } = groupsStore();
    expect(await saveAround(store, () => store.getState().closeGroupDialog())).toEqual([]);
  });

  it('closed while Save reads status, with only a removal to send, sends nothing (follow-up to #205)', async () => {
    const { store } = groupsStore();
    expect(await saveAround(store, () => store.getState().closeGroupDialog(), { scr_1: false })).toEqual([]);
  });

  it('closed while its removal is on its way, the add is not sent (follow-up to #205)', async () => {
    const { store } = groupsStore();
    store.getState().openGroupMembers(ORG, front);
    store.getState().chooseGroupMember('scr_1', false);
    store.getState().chooseGroupMember('scr_2', true);
    const removal = held();
    const saving = store.getState().saveGroupMembers(ORG, front);
    await removal.called;
    store.getState().closeGroupDialog();
    removal.answer({ group: { ...front, screenIds: ['scr_old'], version: 5 } });
    await saving;
    expect(calls()).toEqual([{ name: 'save_group', input: { groupId: front.id, screenIds: ['scr_1'], membership: 'remove' } }]);
  });

  it('Cancel waits while Save runs: the save is all or nothing (follow-up to #205)', async () => {
    const { store } = groupsStore();
    answer({ group: { ...front, screenIds: ['scr_old'], version: 5 } });
    answer({ group: { ...front, screenIds: ['scr_2', 'scr_old'], version: 6 } });
    const sent = await saveAround(
      store,
      () => {
        store.getState().cancelGroupDialog();
        expect(store.getState().groups.dialog).toMatchObject({ kind: 'members', pending: true });
      },
      { scr_1: false, scr_2: true },
    );
    expect(sent.map((c) => c.name)).toEqual(['save_group', 'save_group']);
    expect(store.getState().groups.dialog).toBeNull();
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

describe('a group made here, and a smart group’s rule (#186)', () => {
  const north = { all: [{ key: 'region', op: 'eq' as const, values: ['north'] }] };
  const smart: GroupView = { ...front, id: 'grp_north', name: 'North', screenIds: ['scr_1'], selector: north, version: 2 };

  beforeEach(() => callTool.mockReset());

  it('makes a smart group from its conditions, keyed by the dialog so a retry makes no second one', async () => {
    const { store } = groupsStore();
    const s = () => store.getState();
    s().openNewGroup(ORG);
    s().typeNewGroupName(' North ');
    s().chooseNewGroupKind('rule');
    s().changeRuleTerm(0, { key: 'region', op: 'eq', values: [' north '] });
    const key = s().groups.dialog?.id;
    answer({ group: smart });
    await s().createGroup(ORG);
    expect(calls()).toEqual([{ name: 'save_group', input: { name: 'North', idempotencyKey: key, selector: north } }]);
    expect(s().groups.dialog).toBeNull();
  });

  it('makes a group of the screens ticked, and none for a rule it cannot save, saying why', async () => {
    const { store } = groupsStore();
    const s = () => store.getState();
    s().openNewGroup(ORG);
    s().typeNewGroupName('Front of house');
    s().chooseNewGroupKind('rule');
    await s().createGroup(ORG);
    expect(calls()).toEqual([]);
    expect(s().groups.dialog?.error).toBe('Choose a label for each condition.');
    s().chooseNewGroupKind('list');
    s().chooseGroupMember('scr_2', true);
    s().chooseGroupMember('scr_3', true);
    s().chooseGroupMember('scr_3', false);
    answer({ group: { ...front, id: 'grp_new' } });
    await s().createGroup(ORG);
    expect(calls()).toMatchObject([{ name: 'save_group', input: { name: 'Front of house', screenIds: ['scr_2'] } }]);
  });

  it('saves a changed rule at the version read, and keeps a refusal on the dialog with the conditions', async () => {
    const { store } = groupsStore();
    const s = () => store.getState();
    s().openGroupRule(ORG, smart);
    s().addRuleTerm();
    s().changeRuleTerm(1, { key: 'store', op: 'exists', values: [] });
    refuse('conflict', 'stale', { version: 3 });
    await s().saveGroupRule(ORG, smart);
    expect(s().groups.dialog).toMatchObject({
      kind: 'rule',
      error: 'stale',
      pending: false,
      terms: [north.all[0], { key: 'store', op: 'exists', values: [] }],
    });
    s().removeRuleTerm(1);
    answer({ group: { ...smart, version: 3 } });
    await s().saveGroupRule(ORG, smart);
    expect(calls()[1]).toEqual({ name: 'save_group', input: { groupId: smart.id, selector: north, ifVersion: 2 } });
    expect(s().groups.dialog).toBeNull();
  });
});
