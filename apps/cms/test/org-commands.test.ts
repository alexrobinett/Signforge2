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

const router = { invalidate: vi.fn(async () => {}), navigate: vi.fn(async () => {}) };
const deps = { router, queryClient: {} } as never;
/** The slices these commands touch, with the settings slice's one action they call. */
const appStore = () =>
  createStore<any>()((set, get) => ({
    ...createUiSlice(set, get, deps),
    ...createOrgsSlice(set, get, deps),
    ...createCommandMenuSlice(set, get, deps),
    forgetOrgSettings: () => {},
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
