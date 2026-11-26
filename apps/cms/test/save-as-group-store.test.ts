// "Save as group…" in the store (#186): the page's chips saved as a smart group's rule in one save_group, keyed by the
// opening, then the entry dialog opened aimed at it for "Schedule a playlist for these…"; a view past ten chips is
// said before any call. Tool calls go to a stubbed `callTool` the test answers; nothing waits on a clock.
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { Refusal } from '../src/lib/tools';
import { createSaveAsGroupSlice, type SaveAsGroupSlice } from '../src/state/save-as-group';

const callTool = vi.fn();
vi.mock('~/lib/tools', async (actual) => ({ ...(await actual<object>()), callTool: (name: string, input: unknown) => callTool(name, input) }));
vi.mock('~/server/screens.functions', () => ({ getScreens: vi.fn() }));

const ORG = 'org_1';
const router = { state: { matches: [{ routeId: '/_app', loaderData: { organization: { id: ORG } } }] } };
const NORTH = [
  { key: 'region', values: ['north'] },
  { key: 'type', values: ['drive-thru', 'kiosk'] },
];

function store() {
  const openNewEntry = vi.fn();
  const s = createStore<SaveAsGroupSlice & { openNewEntry: typeof openNewEntry }>()((set, get) => ({
    ...createSaveAsGroupSlice(set as never, get as never, { router, queryClient: new QueryClient() } as never),
    openNewEntry,
  }));
  return { s, openNewEntry };
}

beforeEach(() => callTool.mockReset());

describe('"Save as group…"', () => {
  it('saves the chips as the rule, eq for one value and in for several, under the opening’s own key', async () => {
    const { s, openNewEntry } = store();
    s.getState().openSaveAsGroup(ORG, NORTH, 'done');
    s.getState().nameGroupFromFilters(' North drive-thru ');
    const key = s.getState().saveAsGroup?.key;
    callTool.mockResolvedValueOnce({ group: { id: 'grp_n', name: 'North drive-thru' } });
    await s.getState().saveFiltersAsGroup();
    expect(callTool.mock.calls).toEqual([
      [
        'save_group',
        {
          name: 'North drive-thru',
          idempotencyKey: key,
          selector: {
            all: [
              { key: 'region', op: 'eq', values: ['north'] },
              { key: 'type', op: 'in', values: ['drive-thru', 'kiosk'] },
            ],
          },
        },
      ],
    ]);
    expect(s.getState().saveAsGroup).toBeNull();
    expect(openNewEntry).not.toHaveBeenCalled();
  });

  it('opens the entry dialog aimed at the group it saved, for "Schedule a playlist for these…"', async () => {
    const { s, openNewEntry } = store();
    s.getState().openSaveAsGroup(ORG, NORTH, 'schedule');
    s.getState().nameGroupFromFilters('North');
    callTool.mockResolvedValueOnce({ group: { id: 'grp_n', name: 'North' } });
    await s.getState().saveFiltersAsGroup();
    expect(openNewEntry).toHaveBeenCalledWith(ORG, { target: 'group', groupId: 'grp_n' });
  });

  it('says a view past ten filters, or with no name, before any call, and keeps a refusal on the dialog', async () => {
    const { s, openNewEntry } = store();
    const twelve = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, values: ['v'] }));
    s.getState().openSaveAsGroup(ORG, twelve, 'schedule');
    s.getState().nameGroupFromFilters('Too many');
    await s.getState().saveFiltersAsGroup();
    expect(s.getState().saveAsGroup?.error).toBe("A group's rule has at most 10 filters; this view has 12.");
    s.getState().openSaveAsGroup(ORG, NORTH, 'schedule');
    await s.getState().saveFiltersAsGroup();
    expect(s.getState().saveAsGroup?.error).toBe('Name the group.');
    expect(callTool).not.toHaveBeenCalled();
    s.getState().nameGroupFromFilters('North');
    callTool.mockRejectedValueOnce(new Refusal('conflict', 'a group is named North'));
    await s.getState().saveFiltersAsGroup();
    expect(s.getState().saveAsGroup).toMatchObject({ pending: false, error: 'a group is named North' });
    expect(openNewEntry).not.toHaveBeenCalled();
  });
});
