// Leaving an org, by a switch or by creating one: every editor's drafts belong to the org they were made in, so they go,
// and none of them still counts as unsaved if the tab comes back to that org. Better Auth's client is a stub; nothing
// waits on a clock.
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createOrgsSlice, type OrgsSlice } from '../src/state/orgs';
import { createVersionedDrafts, type Drafts, realClock, savesWaiting } from '../src/state/versioned-draft';

let org = 'org_1';
const orgs = vi.hoisted(() => ({ switchOrganization: vi.fn(), createOrganization: vi.fn() }));
vi.mock('~/lib/orgs', () => orgs);
vi.mock('~/lib/tab-org', () => ({ tabOrgHeaders: async () => ({}) }));

/** An editor store's drafts, as the spot, playlist and brand kit editors and the schedule's dialogs keep theirs. */
function editor() {
  let drafts: Drafts<{ name: string }> = {};
  const module = createVersionedDrafts<{ name: string }>({
    state: { read: () => drafts, write: (change) => (drafts = change(drafts)) },
    save: async () => ({}),
    makeId: () => crypto.randomUUID(),
    currentOrg: () => org,
    clock: realClock,
  });
  return { module, drafts: () => drafts };
}

function store() {
  return createStore<OrgsSlice>()((set, get) => ({
    ...createOrgsSlice(set as never, get as never, { router: {} } as never),
    forgetAgentDrawer: () => {},
    cancelPublishAll: () => {},
    dropSampleCheck: () => {},
    forgetOrgSettings: () => {},
  }));
}

describe('leaving an org', () => {
  it.for(['switch', 'create'] as const)('by a %s drops every editor’s drafts, and none is unsaved back in that org', async (how) => {
    org = 'org_1';
    const spots = editor();
    const playlists = editor();
    spots.module.edit('spt_1', { orgId: 'org_1', record: 'spt_1', version: 1, edit: { name: 'Lobby' } }, () => ({ name: 'Lobby clock' }));
    playlists.module.edit('pls_1', { orgId: 'org_1', record: 'pls_1', version: 3, edit: { name: 'Morning' } }, () => ({ name: 'Mornings' }));
    expect(savesWaiting()).toBe(true);
    const leave = async () => {
      org = 'org_2';
    };
    orgs.switchOrganization.mockImplementation(leave);
    orgs.createOrganization.mockImplementation(leave);
    const s = store();
    if (how === 'switch') await s.getState().switchOrg({ id: 'org_2', name: 'Other' }, 'switcher');
    else {
      s.getState().editOrgName('dialog', 'Other');
      await s.getState().createOrg('dialog');
    }
    expect(spots.drafts()).toEqual({});
    expect(playlists.drafts()).toEqual({});
    org = 'org_1';
    expect(savesWaiting()).toBe(false);
  });
});
