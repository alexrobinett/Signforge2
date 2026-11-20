// The settings slice's actions (review and re-check of #143). One runs at a time on a page, and
// every way out of one (an answer, a refusal, a request with no answer, a reload that fails, the
// browser leaving) releases it. A save sends only the fields edited, with the version they were
// made on. Edits, running actions and errors belong to the org they were made in. Better Auth's
// client, the tools and the router are stubs whose answers the test holds and lets go; nothing
// waits on a clock.
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { Member, OrgSettings } from '../src/lib/settings';
import { createSettingsSlice, editsIn, errorOf, hasEdits, runningIn, type SettingsSlice } from '../src/state/settings';

const auth = vi.hoisted(() => ({
  organization: { updateMemberRole: vi.fn(), inviteMember: vi.fn(), removeMember: vi.fn(), acceptInvitation: vi.fn(), update: vi.fn() },
  linkSocial: vi.fn(),
}));
vi.mock('~/lib/auth-client', async (original) => ({ ...(await original<typeof import('../src/lib/auth-client')>()), authClient: auth }));
// The tab's org comes from the page's router, which a store test has none of.
vi.mock('~/lib/tab-org', () => ({ tabOrgHeaders: async () => ({}) }));
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

const A = 'org_a';
const B = 'org_b';
const ok = { data: {}, error: null };
const settings: OrgSettings = {
  timezone: null,
  locale: null,
  displayHours: null,
  updateWindow: { from: '02:00', to: '05:00' },
  unreachableAfterMinutes: 10,
  editorsPublish: true,
  auditRetentionDays: 90,
  alerts: {
    screen_offline: { who: 'owners', email: true, slack: false, webhook: false },
    publish_finished: { who: 'owners', email: false, slack: false, webhook: false },
    agent_refused: { who: 'owners', email: true, slack: false, webhook: false },
  },
  updatedAt: null,
  version: 1,
};
/** The tools' answers: `update_org_settings`' with its new version, a conflict, a refusal. */
interface Reply {
  status: number;
  body: unknown;
}
const saved = (version: number): Reply => ({ status: 200, body: { settings: { ...settings, version } } });
const conflict: Reply = { status: 409, body: { error: 'conflict', message: 'stale', details: { version: 3 } } };
const refused = (message: string): Reply => ({ status: 400, body: { error: 'error', message } });

/** Each tool call, and the answers to give them in turn (held ones until the test settles them); `{}` when none is queued. */
let calls: { name: string; input: unknown }[] = [];
let replies: (Reply | Promise<Reply>)[] = [];
const lastCall = () => calls.at(-1);

/** The router as the store reads it: the org its shell shows, and what it was asked to do. */
let router: { invalidate: ReturnType<typeof vi.fn>; navigate: ReturnType<typeof vi.fn>; state: { location: { href: string }; matches: unknown[] } };
const showOrg = (id: string) => {
  router.state.matches = [{ routeId: '/_app', loaderData: { organization: { id } } }];
};

function settingsStore() {
  return createStore<SettingsSlice>()((set, get) => createSettingsSlice(set as never, get as never, { router, queryClient: {} } as never));
}

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  replies = [];
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    calls.push({ name: url.split('/').at(-1) ?? '', input: JSON.parse(init.body) });
    const reply = await (replies.shift() ?? { status: 200, body: {} });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  router = { invalidate: vi.fn(async () => {}), navigate: vi.fn(async () => {}), state: { location: { href: '/settings/general' }, matches: [] } };
  showOrg(A);
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
    const changed = store.getState().changeMemberRole(A, 'mem_1', 'viewer');
    await reloading.promise;
    expect(router.invalidate).toHaveBeenCalledWith({ sync: true });
    expect(runningIn(store.getState().settings, { page: 'members', orgId: A })).toBe('role:mem_1');
    expect(store.getState().settings.roleChange).toEqual({ memberId: 'mem_1', role: 'viewer' });

    await store.getState().changeMemberRole(A, 'mem_1', 'owner');
    expect(auth.organization.updateMemberRole).toHaveBeenCalledTimes(1);

    reload.resolve();
    await changed;
    expect(store.getState().settings).toMatchObject({ pending: {}, roleChange: null, errors: {} });
  });

  it('a request that gets no answer releases it, with the action’s own message, and the select goes back', async () => {
    auth.organization.updateMemberRole.mockRejectedValue(new TypeError('Failed to fetch'));
    const store = settingsStore();
    await store.getState().changeMemberRole(A, 'mem_1', 'viewer');
    expect(store.getState().settings).toMatchObject({ pending: {}, roleChange: null });
    expect(errorOf(store.getState().settings, 'role:mem_1', A)?.text).toBe('Could not change the role.');
  });

  it('a refusal releases it', async () => {
    auth.organization.updateMemberRole.mockResolvedValue({ data: null, error: { message: 'An organization needs an owner', status: 400 } });
    const store = settingsStore();
    await store.getState().changeMemberRole(A, 'mem_1', 'viewer');
    expect(store.getState().settings).toMatchObject({ pending: {}, roleChange: null });
    expect(errorOf(store.getState().settings, 'role:mem_1', A)?.text).toBe('An organization needs an owner');
  });

  it('a reload that fails, as when a loader throws a redirect, releases it', async () => {
    auth.organization.updateMemberRole.mockResolvedValue(ok);
    router.invalidate.mockRejectedValue({ isRedirect: true, options: { to: '/sign-in' } });
    const store = settingsStore();
    await store.getState().changeMemberRole(A, 'mem_1', 'viewer');
    expect(store.getState().settings).toMatchObject({ pending: {}, roleChange: null });
  });
});

describe('every way out of an action releases it', () => {
  it('work that throws before any request', async () => {
    const store = settingsStore();
    expect(await store.getState().inviteMembers(A, [], 'editor')).toBe(false);
    expect(store.getState().settings.pending).toEqual({});
    expect(errorOf(store.getState().settings, 'invite', A)?.text).toBe('Enter at least one email address.');
  });

  it('leaving the page after it: the invitation is accepted, then the app goes home', async () => {
    auth.organization.acceptInvitation.mockResolvedValue(ok);
    const store = settingsStore();
    await store.getState().acceptInvitation('inv_1');
    expect(router.navigate).toHaveBeenCalledWith({ to: '/' });
    expect(store.getState().settings.pending).toEqual({});
  });
});

describe('Connect GitHub', () => {
  it('a request that gets no answer shows the GitHub error and lets the next action run', async () => {
    auth.linkSocial.mockRejectedValue(new TypeError('Failed to fetch'));
    const store = settingsStore();
    await store.getState().connectGithub();
    expect(store.getState().settings.pending).toEqual({});
    expect(errorOf(store.getState().settings, 'github', undefined)?.text).toBe('Could not connect GitHub.');
  });

  it('a refusal shows it and releases it', async () => {
    auth.linkSocial.mockResolvedValue({ data: null, error: { message: 'GitHub is not set up', status: 400 } });
    const store = settingsStore();
    await store.getState().connectGithub();
    expect(store.getState().settings.pending).toEqual({});
    expect(errorOf(store.getState().settings, 'github', undefined)?.text).toBe('GitHub is not set up');
  });

  it('is pending while it asks, and released as the browser leaves for GitHub, so a page restored from the back button is not locked', async () => {
    const asking = held<typeof ok>();
    auth.linkSocial.mockReturnValue(asking.promise);
    const store = settingsStore();
    const connecting = store.getState().connectGithub();
    expect(runningIn(store.getState().settings, { page: 'account', orgId: null })).toBe('github');
    asking.resolve(ok);
    await connecting;
    expect(store.getState().settings.pending).toEqual({});
  });
});

describe('a settings save (re-check of #143, 1)', () => {
  it('sends only the fields edited, with the version they were made on; an edit made while it ran stays, on the version it made', async () => {
    const write = held<Reply>();
    replies.push(write.promise, saved(3));
    const store = settingsStore();
    store.getState().editSettings(A, 'general', 1, { auditRetentionDays: '100' });
    const saving = store.getState().saveSettings(A, 'general', settings, { id: A, name: 'Northside' });
    store.getState().editSettings(A, 'general', 2, { auditRetentionDays: '120' });
    write.resolve(saved(2));
    await saving;
    expect(calls).toEqual([{ name: 'update_org_settings', input: { auditRetentionDays: 100, ifVersion: 1 } }]);
    expect(store.getState().settings.drafts.general).toMatchObject({ orgId: A, version: 2, edit: { auditRetentionDays: '120' } });

    await store.getState().saveSettings(A, 'general', { ...settings, version: 2 }, { id: A, name: 'Northside' });
    expect(lastCall()).toEqual({ name: 'update_org_settings', input: { auditRetentionDays: 120, ifVersion: 2 } });
    expect(hasEdits(store.getState().settings, 'general', A)).toBe(false);
  });

  it("a change someone else made since is refused and shown, never overwritten; Reload drops the org's edits", async () => {
    replies.push(conflict);
    const store = settingsStore();
    // Edited on version 2; someone has since set the time zone, making it 3.
    store.getState().editSettings(A, 'general', 2, { auditRetentionDays: '120' });
    await store.getState().saveSettings(A, 'general', { ...settings, timezone: 'Europe/London', version: 3 }, { id: A, name: 'Northside' });
    expect(lastCall()).toEqual({ name: 'update_org_settings', input: { auditRetentionDays: 120, ifVersion: 2 } });
    expect(errorOf(store.getState().settings, 'general', A)).toMatchObject({ stale: true, text: 'This changed since you opened it.' });
    expect(editsIn(store.getState().settings, 'general', A, 3)).toEqual({ auditRetentionDays: '120' });

    await store.getState().reloadSettings(A, 'general');
    expect(editsIn(store.getState().settings, 'general', A, 3)).toEqual({});
    expect(errorOf(store.getState().settings, 'general', A)).toBeUndefined();
  });

  it('with nothing edited, sends nothing, and says so', async () => {
    const store = settingsStore();
    await store.getState().saveSettings(A, 'screens', settings);
    expect(calls).toEqual([]);
    expect(toast).toHaveBeenCalledWith('Nothing to save');
  });
});

describe('the settings pages share one version (third re-check of #143)', () => {
  it("a save moves the org's other drafts on its version to the one it made, so an edit left on General saves after Screens & groups saved", async () => {
    replies.push(saved(2), saved(3));
    const store = settingsStore();
    store.getState().editSettings(A, 'general', 1, { auditRetentionDays: '111' });
    store.getState().editSettings(A, 'screens', 1, { unreachableAfterMinutes: '17' });
    await store.getState().saveSettings(A, 'screens', settings);
    expect(lastCall()).toEqual({ name: 'update_org_settings', input: { unreachableAfterMinutes: 17, ifVersion: 1 } });
    expect(store.getState().settings.drafts.general).toMatchObject({ orgId: A, version: 2, edit: { auditRetentionDays: '111' } });
    await store.getState().saveSettings(A, 'general', { ...settings, version: 2 }, { id: A, name: 'A' });
    expect(lastCall()).toEqual({ name: 'update_org_settings', input: { auditRetentionDays: 111, ifVersion: 2 } });
    expect(errorOf(store.getState().settings, 'general', A)).toBeUndefined();
  });

  it('two forms saved at once take turns: the second sends the version the first made, not a conflict (versioned draft)', async () => {
    const first = held<Reply>();
    replies.push(first.promise, saved(3));
    const store = settingsStore();
    store.getState().editSettings(A, 'general', 1, { auditRetentionDays: '111' });
    store.getState().editSettings(A, 'screens', 1, { unreachableAfterMinutes: '17' });
    const general = store.getState().saveSettings(A, 'general', settings, { id: A, name: 'A' });
    const screens = store.getState().saveSettings(A, 'screens', settings);
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toHaveLength(1);
    expect(runningIn(store.getState().settings, { page: 'screens', orgId: A })).toBe('screens');
    first.resolve(saved(2));
    await Promise.all([general, screens]);
    expect(calls.map((c) => c.input)).toEqual([
      { auditRetentionDays: 111, ifVersion: 1 },
      { unreachableAfterMinutes: 17, ifVersion: 2 },
    ]);
    expect(errorOf(store.getState().settings, 'screens', A)).toBeUndefined();
  });

  it("leaves a draft on an older version, or another org's, where it is: those really were changed since", async () => {
    replies.push(saved(5));
    const store = settingsStore();
    store.getState().editSettings(A, 'publishing', 3, { editorsPublish: false });
    store.getState().editSettings(B, 'notifications', 4, { alerts: { agent_refused: { email: false } } });
    store.getState().editSettings(A, 'screens', 4, { unreachableAfterMinutes: '17' });
    await store.getState().saveSettings(A, 'screens', { ...settings, version: 4 });
    expect(store.getState().settings.drafts.publishing?.version).toBe(3);
    expect(store.getState().settings.drafts.notifications?.version).toBe(4);
  });

  it("Reload after one form's conflict drops only that form's edits; another page's stay", async () => {
    replies.push(conflict);
    const store = settingsStore();
    store.getState().editSettings(A, 'screens', 1, { updateFrom: '03:15' });
    store.getState().editSettings(A, 'general', 1, { auditRetentionDays: '222' });
    await store.getState().saveSettings(A, 'general', settings, { id: A, name: 'A' });
    await store.getState().reloadSettings(A, 'general');
    expect(editsIn(store.getState().settings, 'general', A, 3)).toEqual({});
    expect(editsIn(store.getState().settings, 'screens', A, 1)).toEqual({ updateFrom: '03:15' });
  });

  it('a rename that fails after the settings were written leaves the edits on the version written', async () => {
    replies.push(saved(2), saved(3));
    auth.organization.update.mockResolvedValue({ data: null, error: { message: 'Could not rename the organization.', status: 500 } });
    const store = settingsStore();
    store.getState().editSettings(A, 'general', 1, { name: 'Alpha', auditRetentionDays: '111' });
    await store.getState().saveSettings(A, 'general', settings, { id: A, name: 'A' });
    expect(errorOf(store.getState().settings, 'general', A)?.text).toBe('Could not rename the organization.');
    expect(store.getState().settings.drafts.general?.version).toBe(2);
    auth.organization.update.mockResolvedValue(ok);
    await store.getState().saveSettings(A, 'general', { ...settings, version: 2 }, { id: A, name: 'A' });
    expect(lastCall()).toEqual({ name: 'update_org_settings', input: { auditRetentionDays: 111, ifVersion: 2 } });
  });
});

describe('edits and actions belong to their org (re-check of #143, 2)', () => {
  it('a switch drops the old org’s display hours; its late answer changes nothing in the new one, and a save there sends only its own edits', async () => {
    const write = held<Reply>();
    replies.push(write.promise, saved(8));
    const store = settingsStore();
    store.getState().editSettings(A, 'general', 1, { auditRetentionDays: '100' });
    const saving = store.getState().saveSettings(A, 'general', settings, { id: A, name: 'A' });
    store.getState().editSettings(A, 'general', 1, { displayHours: { weekly: [{ days: [1], from: '08:35', to: '18:00' }] } });
    // The switch.
    store.getState().forgetOrgSettings();
    showOrg(B);
    expect(editsIn(store.getState().settings, 'general', B, 7)).toEqual({});

    write.resolve(saved(2));
    await saving;
    expect(store.getState().settings.drafts).toEqual({});
    // Not announced, and B's page not reloaded on A's account.
    expect(toast.success).not.toHaveBeenCalled();
    expect(router.invalidate).not.toHaveBeenCalled();

    store.getState().editSettings(B, 'general', 7, { auditRetentionDays: '200' });
    await store.getState().saveSettings(B, 'general', { ...settings, version: 7 }, { id: B, name: 'B' });
    expect(lastCall()).toEqual({ name: 'update_org_settings', input: { auditRetentionDays: 200, ifVersion: 7 } });
  });

  it("another org's running action and error do not show, or hold anything up, in the org on screen", async () => {
    const write = held<Reply>();
    replies.push(write.promise);
    const store = settingsStore();
    store.getState().editSettings(A, 'general', 1, { auditRetentionDays: '100' });
    const saving = store.getState().saveSettings(A, 'general', settings, { id: A, name: 'A' });
    expect(runningIn(store.getState().settings, { page: 'general', orgId: B })).toBeUndefined();
    write.resolve(refused('Refused in A'));
    await saving;
    expect(errorOf(store.getState().settings, 'general', A)?.text).toBe('Refused in A');
    expect(errorOf(store.getState().settings, 'general', B)).toBeUndefined();
  });
});

describe('an action waiting on the server (re-check of #143, 3)', () => {
  it('holds up only its own page: a webhook removal with no answer yet leaves General free to save', async () => {
    const removal = held<Reply>();
    replies.push(removal.promise, saved(2));
    const store = settingsStore();
    void store.getState().removeAlertChannel(A, 'webhook');
    store.getState().editSettings(A, 'general', 1, { auditRetentionDays: '100' });
    await store.getState().saveSettings(A, 'general', settings, { id: A, name: 'A' });
    expect(lastCall()).toEqual({ name: 'update_org_settings', input: { auditRetentionDays: 100, ifVersion: 1 } });
    expect(runningIn(store.getState().settings, { page: 'notifications', orgId: A })).toBe('remove:webhook');
  });

  it('a member removal sent can have its dialog closed, and goes on; Keep it cannot close a sent webhook removal', async () => {
    const removal = held<{ data: unknown; error: { message: string; status: number } | null }>();
    auth.organization.removeMember.mockReturnValue(removal.promise);
    const store = settingsStore();
    const member: Member = { id: 'mem_1', role: 'editor', createdAt: '', userId: 'usr_1', user: { id: 'usr_1', name: 'Sam', email: 'sam@example.com' } };
    store.getState().askToRemoveMember(A, member);
    const removing = store.getState().removeMember(A, 'mem_1');
    store.getState().askToRemoveMember(A, null);
    expect(store.getState().settings.removing).toBeNull();
    expect(runningIn(store.getState().settings, { page: 'members', orgId: A })).toBe('remove:mem_1');
    // Nothing else opens while it runs.
    store.getState().askToRemoveMember(A, member);
    expect(store.getState().settings.removing).toBeNull();
    removal.resolve({ data: null, error: { message: 'Not removed', status: 403 } });
    await removing;
    expect(errorOf(store.getState().settings, 'remove:mem_1', A)?.text).toBe('Not removed');

    const channel = held<Reply>();
    replies.push(channel.promise);
    store.getState().askToRemoveAlertChannel(A, 'webhook');
    const removingChannel = store.getState().removeAlertChannel(A, 'webhook');
    store.getState().askToRemoveAlertChannel(A, null);
    expect(store.getState().settings.removingChannel).toEqual({ orgId: A, kind: 'webhook' });
    channel.resolve({ status: 200, body: {} });
    await removingChannel;
    expect(store.getState().settings.removingChannel).toBeNull();
  });
});

describe("the org's name, which the settings' version does not cover (re-check of #153, 1)", () => {
  it("after a rename is saved, the page shows another owner's later rename, and the next General save does not rename it back", async () => {
    auth.organization.update.mockResolvedValue(ok);
    replies.push(saved(2), saved(3));
    const store = settingsStore();
    store.getState().editSettings(A, 'general', 1, { name: 'Mine', auditRetentionDays: '100' });
    await store.getState().saveSettings(A, 'general', settings, { id: A, name: 'A' });
    expect(auth.organization.update).toHaveBeenCalledTimes(1);

    // Another owner renames it "Theirs"; the page reads that, with the settings still at 2.
    expect(editsIn(store.getState().settings, 'general', A, 2).name).toBeUndefined();
    store.getState().editSettings(A, 'general', 2, { timezone: 'Europe/London' });
    await store.getState().saveSettings(A, 'general', { ...settings, version: 2 }, { id: A, name: 'Theirs' });
    expect(auth.organization.update).toHaveBeenCalledTimes(1);
    expect(lastCall()).toMatchObject({ name: 'update_org_settings', input: { timezone: 'Europe/London', ifVersion: 2 } });
  });
});
