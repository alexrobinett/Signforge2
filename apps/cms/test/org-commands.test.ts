// The organization commands (#182): ⌘K offers "Switch organization…" only to a member of two or
// more orgs, and "Create organization…" to everyone; the account menu and ⌘K open one create
// dialog. Better Auth's client is a stub; nothing waits on a clock.
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { orgCommands } from '../src/lib/command-menu';
import { createCommandMenuSlice } from '../src/state/command-menu';
import { createOrgsSlice } from '../src/state/orgs';
import { createUiSlice } from '../src/state/ui';

const orgs = vi.hoisted(() => ({ switchOrganization: vi.fn(async () => {}), createOrganization: vi.fn() }));
vi.mock('~/lib/orgs', () => orgs);
vi.mock('~/server/screens.functions', () => ({ getScreenStatus: vi.fn(), getScreens: vi.fn() }));

const router = { invalidate: vi.fn(async () => {}), navigate: vi.fn(async () => {}) };
const deps = { router, queryClient: {} } as never;
/** The slices these commands touch, with the settings slice's, the agent drawer's and the sidebar Publish's one action they call. */
const forgetAgentDrawer = vi.fn();
const cancelPublishAll = vi.fn();
const appStore = () =>
  createStore<any>()((set, get) => ({
    ...createUiSlice(set, get, deps),
    ...createOrgsSlice(set, get, deps),
    ...createCommandMenuSlice(set, get, deps),
    forgetOrgSettings: () => {},
    forgetAgentDrawer,
    cancelPublishAll,
  }));

describe('orgCommands', () => {
  it('offers switching only to a member of two or more orgs, and creating to everyone', () => {
    expect(orgCommands(0).map((e) => e.label)).toEqual(['Create organization…']);
    expect(orgCommands(1).map((e) => e.label)).toEqual(['Create organization…']);
    expect(orgCommands(2).map((e) => e.label)).toEqual(['Switch organization…', 'Create organization…']);
  });
});

describe('the organization commands in the store', () => {
  const [switchOrgs, createOrg] = orgCommands(2);

  it('Switch organization… lists the orgs in the menu; one chosen closes it and switches, announced', async () => {
    const store = appStore();
    store.getState().openCommandMenu();
    await store.getState().chooseCommand(switchOrgs!);
    expect(store.getState().commandMenu).toMatchObject({ open: true, choosingOrg: true });

    await store.getState().chooseOrg({ id: 'org_b', name: 'Harbor East' });
    expect(store.getState().commandMenu).toMatchObject({ open: false, choosingOrg: false });
    expect(orgs.switchOrganization).toHaveBeenCalledWith(router, 'org_b');
    expect(store.getState().orgs.status).toBe('Switched to Harbor East.');
  });

  it('Back from the org list shows the commands again', async () => {
    const store = appStore();
    store.getState().openCommandMenu();
    await store.getState().chooseCommand(switchOrgs!);
    store.getState().backToCommands();
    expect(store.getState().commandMenu).toMatchObject({ open: true, choosingOrg: false });
  });

  it('Create organization… closes the menu and opens the create dialog', async () => {
    const store = appStore();
    store.getState().openCommandMenu();
    await store.getState().chooseCommand(createOrg!);
    expect(store.getState().commandMenu.open).toBe(false);
    expect(store.getState().orgs.createDialogOpen).toBe(true);
  });

  it('the create dialog, opened from the account menu in the phone drawer, closes the drawer under it', () => {
    const store = appStore();
    store.getState().openDrawer();
    store.getState().openCreateOrg();
    expect(store.getState().ui.drawerOpen).toBe(false);
    expect(store.getState().orgs.createDialogOpen).toBe(true);
  });
});

describe('one switch at a time (review of #208, 3)', () => {
  it('a second switch, from ⌘K or the switcher, while one is on its way does nothing', async () => {
    let release = () => {};
    orgs.switchOrganization.mockClear();
    orgs.switchOrganization.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    const store = appStore();
    store.getState().openCommandMenu();
    const first = store.getState().chooseOrg({ id: 'org_b', name: 'Harbor East' });
    expect(store.getState().orgs.switchingTo).toBe('org_b');

    store.getState().openCommandMenu();
    await store.getState().chooseOrg({ id: 'org_c', name: 'Harbor West' });
    await store.getState().switchOrg({ id: 'org_c', name: 'Harbor West' }, 'switcher');
    expect(orgs.switchOrganization).toHaveBeenCalledTimes(1);
    expect(store.getState().orgs.switchingTo).toBe('org_b');

    release();
    await first;
    expect(store.getState().orgs).toMatchObject({ switchingTo: null, status: 'Switched to Harbor East.' });
    await store.getState().chooseOrg({ id: 'org_c', name: 'Harbor West' });
    expect(orgs.switchOrganization).toHaveBeenLastCalledWith(router, 'org_c');
  });
});

describe('creating an org and switching, one at a time (re-check of #208)', () => {
  it('a create asked for while a switch is on its way does nothing, and its draft waits', async () => {
    let release = () => {};
    orgs.switchOrganization.mockClear();
    orgs.createOrganization.mockClear();
    orgs.switchOrganization.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    const store = appStore();
    const switching = store.getState().switchOrg({ id: 'org_b', name: 'Harbor East' }, 'switcher');
    store.getState().openCreateOrg();
    store.getState().editOrgName('dialog', 'Harbor West');
    await store.getState().createOrg('dialog');
    expect(orgs.createOrganization).not.toHaveBeenCalled();
    expect(store.getState().orgs.drafts.dialog).toMatchObject({ name: 'Harbor West', pending: false });

    release();
    await switching;
    orgs.createOrganization.mockResolvedValueOnce({ id: 'org_c' });
    await store.getState().createOrg('dialog');
    expect(orgs.createOrganization).toHaveBeenCalledWith(router, 'Harbor West');
  });

  it('a switch asked for while a create is on its way does nothing', async () => {
    let release = (_: unknown) => {};
    orgs.switchOrganization.mockClear();
    orgs.createOrganization.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const store = appStore();
    store.getState().editOrgName('dialog', 'Harbor West');
    const creating = store.getState().createOrg('dialog');
    await store.getState().switchOrg({ id: 'org_b', name: 'Harbor East' }, 'switcher');
    await store.getState().chooseOrg({ id: 'org_b', name: 'Harbor East' });
    expect(orgs.switchOrganization).not.toHaveBeenCalled();

    release({ id: 'org_c' });
    await creating;
    await store.getState().switchOrg({ id: 'org_b', name: 'Harbor East' }, 'switcher');
    expect(orgs.switchOrganization).toHaveBeenCalledWith(router, 'org_b');
  });
});

describe('switching org', () => {
  it("forgets the agent drawer's conversation, and its turn on its way, before the switch: none of it goes to the next org (review of #327)", async () => {
    const store = appStore();
    forgetAgentDrawer.mockClear();
    orgs.switchOrganization.mockClear();
    orgs.switchOrganization.mockImplementationOnce(async () => {
      // By the time the switch starts, the drawer has forgotten.
      expect(forgetAgentDrawer).toHaveBeenCalledTimes(1);
    });
    await store.getState().switchOrg({ id: 'org_c', name: 'Harbor West' }, 'switcher');
    expect(orgs.switchOrganization).toHaveBeenCalledTimes(1);
    expect(forgetAgentDrawer).toHaveBeenCalledTimes(1);
  });

  it("closes the sidebar's Publish question before the switch: what it read is the last org's (review of #395)", async () => {
    const store = appStore();
    cancelPublishAll.mockClear();
    orgs.switchOrganization.mockImplementationOnce(async () => {
      expect(cancelPublishAll).toHaveBeenCalledTimes(1);
    });
    await store.getState().switchOrg({ id: 'org_c', name: 'Harbor West' }, 'switcher');
    expect(cancelPublishAll).toHaveBeenCalledTimes(1);
  });
});

describe('creating an org', () => {
  it("forgets the agent drawer's conversation before the new org becomes active (re-check of #327)", async () => {
    const store = appStore();
    forgetAgentDrawer.mockClear();
    orgs.createOrganization.mockClear();
    orgs.createOrganization.mockImplementationOnce(async () => {
      expect(forgetAgentDrawer).toHaveBeenCalledTimes(1);
    });
    store.getState().editOrgName('dialog', 'Harbor North');
    await store.getState().createOrg('dialog');
    expect(orgs.createOrganization).toHaveBeenCalledTimes(1);
    expect(forgetAgentDrawer).toHaveBeenCalledTimes(1);
  });
});
