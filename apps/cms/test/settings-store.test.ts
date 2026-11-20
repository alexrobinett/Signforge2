// The settings slice's actions (review of #143): one runs at a time, and every way out of one,
// an answer, a refusal, a request with no answer, a reload that fails, the browser leaving,
// releases it. Better Auth's client and the router are stubs whose answers the test holds and
// lets go; nothing waits on a clock.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { Member } from '../src/lib/settings';
import { createSettingsSlice, type SettingsSlice } from '../src/state/settings';

const auth = vi.hoisted(() => ({
  organization: { updateMemberRole: vi.fn(), inviteMember: vi.fn(), removeMember: vi.fn(), acceptInvitation: vi.fn() },
  linkSocial: vi.fn(),
}));
vi.mock('~/lib/auth-client', async (original) => ({ ...(await original<typeof import('../src/lib/auth-client')>()), authClient: auth }));
const callTool = vi.hoisted(() => vi.fn());
vi.mock('~/lib/tools', async (original) => ({ ...(await original<typeof import('../src/lib/tools')>()), callTool }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn() }) }));

/** A promise the test settles when it chooses. */
function held<T>() {
  let resolve: (v: T) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const ok = { data: {}, error: null };
let router: { invalidate: ReturnType<typeof vi.fn>; navigate: ReturnType<typeof vi.fn> };

function settingsStore() {
  return createStore<SettingsSlice>()((set, get) => createSettingsSlice(set as never, get as never, { router, queryClient: {} } as never));
}

beforeEach(() => {
  vi.clearAllMocks();
  router = { invalidate: vi.fn(async () => {}), navigate: vi.fn(async () => {}) };
});

describe('a member role change', () => {
  it("stays pending, its select on the new role, until the page's loaders have finished; a change meanwhile is ignored", async () => {
    auth.organization.updateMemberRole.mockResolvedValue(ok);
    const reloading = held<void>();
    const reload = held<void>();
    router.invalidate.mockImplementation(() => {
      reloading.resolve();
      return reload.promise;
    });
    const store = settingsStore();
    const changed = store.getState().changeMemberRole('mem_1', 'viewer');
    await reloading.promise;
    expect(router.invalidate).toHaveBeenCalledWith({ sync: true });
    expect(store.getState().settings).toMatchObject({ pending: 'role:mem_1', roleChange: { memberId: 'mem_1', role: 'viewer' } });

    await store.getState().changeMemberRole('mem_1', 'owner');
    expect(auth.organization.updateMemberRole).toHaveBeenCalledTimes(1);
    expect(store.getState().settings.roleChange).toEqual({ memberId: 'mem_1', role: 'viewer' });

    reload.resolve();
    await changed;
    expect(store.getState().settings).toMatchObject({ pending: null, roleChange: null, error: null });
  });

  it('a request that gets no answer releases it, with the action’s own message, and the select goes back', async () => {
    auth.organization.updateMemberRole.mockRejectedValue(new TypeError('Failed to fetch'));
    const store = settingsStore();
    await store.getState().changeMemberRole('mem_1', 'viewer');
    expect(store.getState().settings).toMatchObject({ pending: null, roleChange: null, error: { at: 'role:mem_1', text: 'Could not change the role.' } });
  });

  it('a refusal releases it', async () => {
    auth.organization.updateMemberRole.mockResolvedValue({ data: null, error: { message: 'An organization needs an owner', status: 400 } });
    const store = settingsStore();
    await store.getState().changeMemberRole('mem_1', 'viewer');
    expect(store.getState().settings).toMatchObject({ pending: null, roleChange: null, error: { text: 'An organization needs an owner' } });
  });

  it('a reload that fails, as when a loader throws a redirect, releases it', async () => {
    auth.organization.updateMemberRole.mockResolvedValue(ok);
    router.invalidate.mockRejectedValue({ isRedirect: true, options: { to: '/sign-in' } });
    const store = settingsStore();
    await store.getState().changeMemberRole('mem_1', 'viewer');
    expect(store.getState().settings).toMatchObject({ pending: null, roleChange: null });
  });
});

describe('every way out of an action releases it', () => {
  it('work that throws before any request', async () => {
    const store = settingsStore();
    expect(await store.getState().inviteMembers([], 'editor')).toBe(false);
    expect(store.getState().settings).toMatchObject({ pending: null, error: { at: 'invite', text: 'Enter at least one email address.' } });
  });

  it('leaving the page after it: the invitation is accepted, then the app goes home', async () => {
    auth.organization.acceptInvitation.mockResolvedValue(ok);
    const store = settingsStore();
    await store.getState().acceptInvitation('inv_1');
    expect(router.navigate).toHaveBeenCalledWith({ to: '/' });
    expect(store.getState().settings.pending).toBeNull();
  });
});

describe('Connect GitHub', () => {
  it('a request that gets no answer shows the GitHub error and lets the next action run', async () => {
    auth.linkSocial.mockRejectedValue(new TypeError('Failed to fetch'));
    const store = settingsStore();
    await store.getState().connectGithub();
    expect(store.getState().settings).toMatchObject({ pending: null, error: { at: 'github', text: 'Could not connect GitHub.' } });

    callTool.mockResolvedValue({});
    await store.getState().saveEditorsPublish(false, 1);
    expect(callTool).toHaveBeenCalledWith('update_org_settings', { editorsPublish: false, ifVersion: 1 });
  });

  it('a refusal shows it and releases it', async () => {
    auth.linkSocial.mockResolvedValue({ data: null, error: { message: 'GitHub is not set up', status: 400 } });
    const store = settingsStore();
    await store.getState().connectGithub();
    expect(store.getState().settings).toMatchObject({ pending: null, error: { at: 'github', text: 'GitHub is not set up' } });
  });

  it('is pending while it asks, and released as the browser leaves for GitHub, so a page restored from the back button is not locked', async () => {
    const asking = held<typeof ok>();
    auth.linkSocial.mockReturnValue(asking.promise);
    const store = settingsStore();
    const connecting = store.getState().connectGithub();
    expect(store.getState().settings.pending).toBe('github');
    await store.getState().saveEditorsPublish(false, 1);
    expect(callTool).not.toHaveBeenCalled();
    asking.resolve(ok);
    await connecting;
    expect(store.getState().settings).toMatchObject({ pending: null, error: null });
  });
});

describe('edits made while a save runs', () => {
  it('General keeps a display-hours edit made while it saved, and drops the one it saved', async () => {
    const answer = held<unknown>();
    callTool.mockReturnValue(answer.promise);
    const store = settingsStore();
    const values = { name: 'Northside', timezone: null, locale: null, auditRetentionDays: 90 };
    store.getState().editDefaultHours(null);
    const saving = store.getState().saveGeneral({ id: 'org_1', name: 'Northside' }, values, 1);
    store.getState().editDefaultHours({ weekly: [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' }] });
    const typed = store.getState().settings.hours;
    answer.resolve({});
    await saving;
    expect(store.getState().settings.hours).toBe(typed);

    callTool.mockResolvedValue({});
    await store.getState().saveGeneral({ id: 'org_1', name: 'Northside' }, values, 2);
    expect(store.getState().settings.hours).toBeNull();
  });
});

describe('a removal once sent', () => {
  it('keeps its confirmation open until it is answered: Keep it, or Cancel, cannot call it back', async () => {
    const answer = held<unknown>();
    callTool.mockReturnValue(answer.promise);
    const store = settingsStore();
    store.getState().askToRemoveAlertChannel('webhook');
    const removing = store.getState().removeAlertChannel('webhook');
    store.getState().askToRemoveAlertChannel(null);
    expect(store.getState().settings.removingChannel).toBe('webhook');
    answer.resolve({});
    await removing;
    expect(store.getState().settings.removingChannel).toBeNull();

    const removal = held<typeof ok>();
    auth.organization.removeMember.mockReturnValue(removal.promise);
    const member: Member = { id: 'mem_1', role: 'editor', createdAt: '', userId: 'usr_1', user: { id: 'usr_1', name: 'Sam', email: 'sam@example.com' } };
    store.getState().askToRemoveMember(member);
    const removingMember = store.getState().removeMember('mem_1');
    store.getState().askToRemoveMember(null);
    expect(store.getState().settings.removing).toBe(member);
    removal.resolve(ok);
    await removingMember;
    expect(store.getState().settings.removing).toBeNull();
  });
});
