// The settings slice's actions (review and re-check of #143). One runs at a time on a page, and
// every way out of one (an answer, a refusal, a request with no answer, a reload that fails, the
// browser leaving) releases it. A save sends only the fields edited, with the version they were
// made on. Edits, running actions and errors belong to the org they were made in. Better Auth's
// client, the tools and the router are stubs whose answers the test holds and lets go; nothing
// waits on a clock.
import { TAB_ORG_HEADER } from '@signforge/api/tab-org';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { Member, OrgSettings } from '../src/lib/settings';
import { initialOrgs, type OrgsState } from '../src/state/orgs';
import { createSettingsSlice, editsIn, errorOf, hasEdits, runningIn, settingsProblems, type SettingsSlice } from '../src/state/settings';

const auth = vi.hoisted(() => ({
  organization: { updateMemberRole: vi.fn(), inviteMember: vi.fn(), removeMember: vi.fn(), acceptInvitation: vi.fn(), update: vi.fn() },
  linkSocial: vi.fn(),
  updateUser: vi.fn(),
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
    publish_requested: { who: 'editors', email: true, slack: false, webhook: false },
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
/** The org each call named, in the order sent (`TAB_ORG_HEADER`). */
let named: (string | null)[] = [];
let replies: (Reply | Promise<Reply>)[] = [];
const lastCall = () => calls.at(-1);

/** The router as the store reads it: the org its shell shows, and what it was asked to do. */
let router: { invalidate: ReturnType<typeof vi.fn>; navigate: ReturnType<typeof vi.fn>; state: { location: { href: string }; matches: unknown[] } };
const showOrg = (id: string) => {
  router.state.matches = [{ routeId: '/_app', loaderData: { organization: { id } } }];
};

function settingsStore() {
  return createStore<SettingsSlice & { orgs: OrgsState }>()((set, get) => ({
    orgs: initialOrgs,
    ...createSettingsSlice(set as never, get as never, { router, queryClient: {} } as never),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  replies = [];
  named = [];
  vi.stubGlobal('fetch', async (url: string, init: { body: string; headers: HeadersInit }) => {
    calls.push({ name: url.split('/').at(-1) ?? '', input: JSON.parse(init.body) });
    named.push(new Headers(init.headers).get(TAB_ORG_HEADER));
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

  it('with nothing edited, as when a field is left unchanged, sends nothing and says nothing (#366)', async () => {
    const store = settingsStore();
    await store.getState().saveSettings(A, 'screens', settings);
    expect(calls).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
  });
});

describe('Settings save on change (#366)', () => {
  it('a saved change says so quietly, in the form, with no toast', async () => {
    replies.push(saved(2));
    const store = settingsStore();
    store.getState().editSettings(A, 'screens', 1, { unreachableAfterMinutes: '15' });
    await store.getState().saveSettings(A, 'screens', settings);
    expect(lastCall()).toEqual({ name: 'update_org_settings', input: { unreachableAfterMinutes: 15, ifVersion: 1 } });
    expect(store.getState().settings.drafts.screens).toMatchObject({ status: 'saved' });
    expect(toast).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('a field left with a value the server would refuse is marked there and not sent; fixed, it saves', async () => {
    replies.push(saved(2));
    const store = settingsStore();
    store.getState().editSettings(A, 'general', 1, { auditRetentionDays: '12' });
    await store.getState().saveSettings(A, 'general', settings, { id: A, name: 'Northside' });
    expect(calls).toEqual([]);
    expect(store.getState().settings.drafts.general?.status).toBe('invalid');
    expect(settingsProblems({ auditRetentionDays: '12' }, settings)).toEqual({ auditRetentionDays: 'A whole number of days, 30 to 3,650.' });
    expect(settingsProblems({ name: ' ', updateTo: '02:00' }, settings)).toEqual({
      name: 'Enter a name.',
      updateTo: 'The window must end at another time than it starts.',
    });
    store.getState().editSettings(A, 'general', 1, { auditRetentionDays: '120' });
    await store.getState().saveSettings(A, 'general', settings, { id: A, name: 'Northside' });
    expect(lastCall()).toEqual({ name: 'update_org_settings', input: { auditRetentionDays: 120, ifVersion: 1 } });
  });

  it('two choices made while the first saves: the second follows it with the latest, and nothing is left unsaved', async () => {
    const first = held<Reply>();
    replies.push(first.promise, saved(3));
    const store = settingsStore();
    store.getState().editSettings(A, 'publishing', 1, { editorsPublish: false });
    const one = store.getState().saveSettings(A, 'publishing', settings);
    store.getState().editSettings(A, 'publishing', 1, { editorsPublish: true });
    const two = store.getState().saveSettings(A, 'publishing', settings);
    first.resolve(saved(2));
    await Promise.all([one, two]);
    expect(calls.map((c) => c.input)).toEqual([
      { editorsPublish: false, ifVersion: 1 },
      { editorsPublish: true, ifVersion: 2 },
    ]);
    expect(store.getState().settings.drafts.publishing).toMatchObject({ status: 'saved', version: 3 });
  });

  it('an AI choice made while the one before it saves follows it, on the version that save made: not dropped, not a conflict', async () => {
    const first = held<Reply>();
    const provider = (version: number): Reply => ({ status: 200, body: { provider: { version } } });
    replies.push(first.promise, provider(3), provider(4));
    const store = settingsStore();
    const one = store.getState().saveAiChoices(A, 'anthropic', { fastModel: 'fast-1', capableModel: '', dailyTurnCeiling: '' }, 1);
    // Chosen from the page as it was drawn, on version 1, while the first is on its way; and a third meanwhile: the
    // two waiting go one after the other, neither dropped.
    const two = store.getState().saveAiChoices(A, 'anthropic', { fastModel: 'fast-1', capableModel: 'big-1', dailyTurnCeiling: '' }, 1);
    const three = store.getState().saveAiChoices(A, 'anthropic', { fastModel: 'fast-1', capableModel: 'big-1', dailyTurnCeiling: '300' }, 1);
    first.resolve(provider(2));
    await Promise.all([one, two, three]);
    expect(calls.map((c) => c.input)).toMatchObject([
      { capableModel: null, ifVersion: 1 },
      { capableModel: 'big-1', ifVersion: 2 },
      { dailyTurnCeiling: 300, ifVersion: 3 },
    ]);
  });

  it('a choice made while an action runs on its page waits for that action, then saves: it is not dropped', async () => {
    const removal = held<Reply>();
    replies.push(removal.promise, saved(2));
    const store = settingsStore();
    void store.getState().removeAlertChannel(A, 'webhook');
    store.getState().editSettings(A, 'notifications', 1, { alerts: { screen_offline: { slack: true } } });
    const saving = store.getState().saveSettings(A, 'notifications', settings);
    await new Promise((r) => setImmediate(r));
    expect(calls.map((c) => c.name)).toEqual(['remove_alert_channel']);
    removal.resolve({ status: 200, body: {} });
    await saving;
    expect(lastCall()).toEqual({ name: 'update_org_settings', input: { alerts: { screen_offline: { slack: true } }, ifVersion: 1 } });
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

describe('AI model (#261)', () => {
  const provider = {
    provider: 'anthropic',
    keyLast4: '7Q2c',
    keySavedBy: 'u',
    keySavedAt: 1,
    verifiedAt: 2,
    fastModel: null,
    capableModel: null,
    dailyTurnCeiling: null,
    version: 2,
  };

  it('a test that reaches the provider makes its models the choices, in that org only', async () => {
    const store = settingsStore();
    replies.push({ status: 200, body: { ok: true, models: ['m-fast', 'm-capable'], problem: null, provider } });
    await store.getState().testAiProvider(A);
    expect(lastCall()).toEqual({ name: 'test_ai_provider', input: {} });
    expect(store.getState().settings.aiModels).toEqual({ orgId: A, models: ['m-fast', 'm-capable'] });
    store.getState().forgetOrgSettings();
    expect(store.getState().settings.aiModels).toBeNull();
  });

  it('a test the provider refuses says why in words, and lists nothing', async () => {
    const store = settingsStore();
    replies.push({ status: 200, body: { ok: false, models: [], problem: 'refused', provider } });
    await store.getState().testAiProvider(A);
    expect(errorOf(store.getState().settings, 'test', A)?.text).toMatch(/^Anthropic refused the key/);
    expect(store.getState().settings.aiModels).toBeNull();
    // The key lost its verified mark: the page reads it again, so "Connected" does not stay beside the refusal (re-check of #280).
    expect(router.invalidate).toHaveBeenCalledWith({ sync: true });
  });

  it('saves the choices as the tool takes them: empty is none, the ceiling a number, with the version read', async () => {
    const store = settingsStore();
    await store.getState().saveAiChoices(A, 'anthropic', { fastModel: 'm-fast', capableModel: '', dailyTurnCeiling: ' 300 ' }, 2);
    expect(lastCall()).toEqual({
      name: 'save_ai_provider',
      input: { provider: 'anthropic', fastModel: 'm-fast', capableModel: null, dailyTurnCeiling: 300, ifVersion: 2 },
    });
    await store.getState().saveAiChoices(A, 'anthropic', { fastModel: '', capableModel: '', dailyTurnCeiling: '' }, 3);
    expect(lastCall()?.input).toMatchObject({ fastModel: null, dailyTurnCeiling: null });
  });

  it('saves an OpenAI-compatible endpoint with its address and features, and keeps the saved key when none is typed (#262)', async () => {
    const store = settingsStore();
    const form = {
      provider: 'openai-compatible' as const,
      apiKey: ' sk-endpoint-key-0000000000000000 ',
      baseUrl: ' https://api.openai.com/v1 ',
      acceptsImages: true,
      jsonSchemaOutput: false,
    };
    await store.getState().saveAiKey(A, form);
    expect(lastCall()).toEqual({
      name: 'save_ai_provider',
      input: {
        provider: 'openai-compatible',
        apiKey: 'sk-endpoint-key-0000000000000000',
        baseUrl: 'https://api.openai.com/v1',
        acceptsImages: true,
        jsonSchemaOutput: false,
      },
    });
    await store.getState().saveAiKey(A, { ...form, apiKey: '', acceptsImages: false }, 4);
    expect(lastCall()?.input).toEqual({
      provider: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      acceptsImages: false,
      jsonSchemaOutput: false,
      ifVersion: 4,
    });
    // Anthropic sends no address or features, whatever the hidden fields hold.
    await store.getState().saveAiKey(A, { ...form, provider: 'anthropic' }, 5);
    expect(lastCall()?.input).toEqual({ provider: 'anthropic', apiKey: 'sk-endpoint-key-0000000000000000', ifVersion: 5 });
  });

  it("says an endpoint's refusals in its own words, a blocked address among them (#262)", async () => {
    const store = settingsStore();
    replies.push({ status: 200, body: { ok: false, models: [], problem: 'blocked', provider: { ...provider, provider: 'openai-compatible' } } });
    await store.getState().testAiProvider(A);
    expect(errorOf(store.getState().settings, 'test', A)?.text).toMatch(/^SignForge cannot reach that address: it must be public https/);
    replies.push({ status: 200, body: { ok: false, models: [], problem: 'refused', provider: { ...provider, provider: 'openai-compatible' } } });
    await store.getState().testAiProvider(A);
    expect(errorOf(store.getState().settings, 'test', A)?.text).toMatch(/^The endpoint refused the key/);
  });
});

describe('focus as Remove gives way to its confirmation, and back (#289)', () => {
  /** An element as a ref callback gets it: only `focus` is used. */
  const element = () => ({ focus: vi.fn() });
  const mount = (store: ReturnType<typeof settingsStore>, key: string) => {
    const el = element();
    store.getState().focusWhenReplaced(key)(el as never);
    return el.focus;
  };

  it('names what takes focus next: the question as it opens, Remove on Keep it, the form once removed; each once', async () => {
    const store = settingsStore();
    // One callback a key, so React calls it as its element mounts, not on every render.
    expect(store.getState().focusWhenReplaced('remove:webhook')).toBe(store.getState().focusWhenReplaced('remove:webhook'));
    expect(mount(store, 'remove:webhook')).not.toHaveBeenCalled();

    store.getState().askToRemoveAlertChannel(A, 'webhook');
    expect(mount(store, 'remove:webhook')).not.toHaveBeenCalled();
    expect(mount(store, 'confirm:webhook')).toHaveBeenCalledTimes(1);
    // Once: rendered again, it does not take focus again.
    expect(mount(store, 'confirm:webhook')).not.toHaveBeenCalled();

    store.getState().askToRemoveAlertChannel(A, null);
    expect(mount(store, 'remove:webhook')).toHaveBeenCalledTimes(1);

    // Removed: the card's form to set one.
    store.getState().askToRemoveAlertChannel(A, 'webhook');
    replies.push(Promise.resolve({ status: 200, body: {} }));
    await store.getState().removeAlertChannel(A, 'webhook');
    expect(mount(store, 'form:webhook')).toHaveBeenCalledTimes(1);
  });

  it('names nothing when the confirmation does not change, and nothing once a removal is refused: the confirmation stays', async () => {
    const store = settingsStore();
    store.getState().askToRemoveAiKey(A, true);
    expect(mount(store, 'confirm:key')).toHaveBeenCalledTimes(1);
    const removal = held<Reply>();
    replies.push(removal.promise);
    const removing = store.getState().removeAiKey(A);
    // Keep it waits for a removal that has been sent: nothing changes, so focus stays where it is.
    store.getState().askToRemoveAiKey(A, false);
    expect(mount(store, 'remove:key')).not.toHaveBeenCalled();
    removal.resolve({ status: 403, body: { error: 'forbidden', message: 'Not removed' } });
    await removing;
    expect(mount(store, 'form:key')).not.toHaveBeenCalled();
    expect(store.getState().settings.removingAiKey).toBe(A);
  });

  it('keeps focus named for the removal under way when a second press is refused as it runs (review of #421)', async () => {
    const store = settingsStore();
    store.getState().askToRemoveAlertChannel(A, 'webhook');
    mount(store, 'confirm:webhook');
    const first = held<Reply>();
    replies.push(first.promise);
    const removing = store.getState().removeAlertChannel(A, 'webhook');
    // Pressed again while the first runs: refused, and the first's target stays.
    await store.getState().removeAlertChannel(A, 'webhook');
    first.resolve({ status: 200, body: {} });
    await removing;
    expect(mount(store, 'form:webhook')).toHaveBeenCalledTimes(1);
  });

  it('gives no focus to a page left while its removal ran, nor in another org (review of #421)', async () => {
    const store = settingsStore();
    router.state.location.href = '/settings/notifications';
    store.getState().askToRemoveAlertChannel(A, 'webhook');
    mount(store, 'confirm:webhook');
    const away = held<Reply>();
    replies.push(away.promise);
    const removing = store.getState().removeAlertChannel(A, 'webhook');
    // Left for the screens while it ran; back later, the form is not to take focus then.
    router.state.location.href = '/screens';
    away.resolve({ status: 200, body: {} });
    await removing;
    router.state.location.href = '/settings/notifications';
    expect(mount(store, 'form:webhook')).not.toHaveBeenCalled();

    // Named in one org, the other org's same control does not take it; and a switch forgets it.
    store.getState().askToRemoveAiKey(A, true);
    showOrg(B);
    expect(mount(store, 'confirm:key')).not.toHaveBeenCalled();
    showOrg(A);
    store.getState().forgetOrgSettings();
    expect(mount(store, 'confirm:key')).not.toHaveBeenCalled();
  });
});

describe('a save made in one org never writes to another (review of #466)', () => {
  it('an AI choice waiting behind another is not sent once the tab has left its org; the one sent named its org', async () => {
    const first = held<Reply>();
    replies.push(first.promise, { status: 200, body: { provider: { version: 5 } } });
    const store = settingsStore();
    const one = store.getState().saveAiChoices(A, 'anthropic', { fastModel: 'fast-1', capableModel: '', dailyTurnCeiling: '' }, 3);
    const two = store.getState().saveAiChoices(A, 'anthropic', { fastModel: 'fast-1', capableModel: 'big-1', dailyTurnCeiling: '' }, 3);
    showOrg(B);
    store.getState().forgetOrgSettings();
    first.resolve({ status: 200, body: { provider: { version: 4 } } });
    await Promise.all([one, two]);
    expect(calls.map((c) => c.name)).toEqual(['save_ai_provider']);
    expect(named).toEqual([A]);
  });

  it('a settings save names the org its edits were made in, whatever the tab names by then', async () => {
    const first = held<Reply>();
    replies.push(first.promise, saved(3));
    const store = settingsStore();
    store.getState().editSettings(A, 'general', 1, { auditRetentionDays: '100' });
    const one = store.getState().saveSettings(A, 'general', settings);
    store.getState().editSettings(A, 'general', 1, { auditRetentionDays: '120' });
    const two = store.getState().saveSettings(A, 'general', settings);
    first.resolve(saved(2));
    await Promise.all([one, two]);
    expect(named).toEqual([A, A]);
  });

  it("a choice waits for an action on its page that is not the page's own run, Connect GitHub, rather than spinning", async () => {
    let linked: (v: unknown) => void = () => {};
    auth.linkSocial.mockReturnValueOnce(new Promise((r) => (linked = r)));
    auth.updateUser.mockResolvedValue(ok);
    let reads = 0;
    // A loop that never yields would read the state without end: stopped, so the test says so rather than hanging.
    const store = createStore<SettingsSlice & { orgs: OrgsState }>()((set, get) => ({
      orgs: initialOrgs,
      ...createSettingsSlice(
        set as never,
        (() => {
          if (++reads > 100_000) throw new Error('read the state with no end, without yielding');
          return get();
        }) as never,
        { router, queryClient: {} } as never,
      ),
    }));
    void store.getState().connectGithub();
    const saving = store.getState().saveProfile('Maria Okafor');
    await new Promise((r) => setImmediate(r));
    expect(auth.updateUser).not.toHaveBeenCalled();
    linked({ data: {}, error: null });
    await saving;
    expect(auth.updateUser).toHaveBeenCalledWith({ name: 'Maria Okafor' });
  });
});

describe('the org name and the AI version, saved on change (review of #466)', () => {
  it('a name put back while its rename is on its way is sent, not taken for the name the page read', async () => {
    let renamed: (v: unknown) => void = () => {};
    auth.organization.update.mockReturnValueOnce(new Promise((r) => (renamed = r))).mockResolvedValue(ok);
    const store = settingsStore();
    store.getState().editSettings(A, 'general', 1, { name: 'Northside Diner' });
    const one = store.getState().saveSettings(A, 'general', settings, { id: A, name: 'Northside' });
    await new Promise((r) => setImmediate(r));
    store.getState().editSettings(A, 'general', 1, { name: 'Northside' });
    const two = store.getState().saveSettings(A, 'general', settings, { id: A, name: 'Northside' });
    renamed(ok);
    await Promise.all([one, two]);
    expect(auth.organization.update.mock.calls.map((c) => c[0].data.name)).toEqual(['Northside Diner', 'Northside']);
  });

  it('after the key is removed and saved again, a model choice builds on the provider as read, not a version from before', async () => {
    replies.push(
      { status: 200, body: { provider: { version: 5 } } },
      { status: 200, body: {} },
      { status: 200, body: { provider: { version: 1 } } },
      {
        status: 200,
        body: { provider: { version: 2 } },
      },
    );
    const store = settingsStore();
    await store.getState().saveAiChoices(A, 'anthropic', { fastModel: 'fast-1', capableModel: '', dailyTurnCeiling: '' }, 4);
    await store.getState().removeAiKey(A);
    await store.getState().saveAiKey(A, { provider: 'anthropic', apiKey: 'sk-new', baseUrl: '', acceptsImages: false, jsonSchemaOutput: false });
    await store.getState().saveAiChoices(A, 'anthropic', { fastModel: 'fast-2', capableModel: '', dailyTurnCeiling: '' }, 1);
    expect(calls.at(-1)).toMatchObject({ name: 'save_ai_provider', input: { fastModel: 'fast-2', ifVersion: 1 } });
  });

  it('display hours the page marks are not sent with the next change', async () => {
    const store = settingsStore();
    store.getState().editSettings(A, 'general', 1, { displayHours: { weekly: [{ days: [], from: '09:00', to: '17:00' }] } });
    store.getState().editSettings(A, 'general', 1, { timezone: 'Europe/London' });
    await store.getState().saveSettings(A, 'general', settings, { id: A, name: 'Northside' });
    expect(calls).toEqual([]);
    expect(store.getState().settings.drafts.general?.status).toBe('invalid');
  });
});
