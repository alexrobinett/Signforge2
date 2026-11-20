// The publish toast (M3-19 review): each publish's toast replaces the last one, under one id, and
// sonner merges what it is given into the toast it replaces. So a takeover's toast, which offers no
// Undo, must still clear the Undo of the publish before it, whenever it comes. Read from sonner's
// own store, two publishes in a row, nothing on a timer. One with Undo stays until used or closed.
import { QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { ScheduleEntryView } from '../src/lib/schedule';
import { callTool } from '../src/lib/tools';
import { getPlaylists } from '../src/server/playlists.functions';
import { getSchedule } from '../src/server/schedule.functions';
import { getSpots } from '../src/server/spots.functions';
import { createPublishingSlice, type PublishingSlice } from '../src/state/publishing';

vi.mock('~/lib/tab-org', () => ({ tabOrgHeaders: async () => ({}) }));
vi.mock('~/lib/tools', async (original) => ({ ...(await original<typeof import('../src/lib/tools')>()), callTool: vi.fn() }));
vi.mock('~/server/schedule.functions', () => ({ getSchedule: vi.fn() }));
vi.mock('~/server/playlists.functions', () => ({ getPlaylists: vi.fn(), getPlaylist: vi.fn() }));
vi.mock('~/server/spots.functions', () => ({ getBrandKits: vi.fn(), getSpot: vi.fn(), getSpotPreview: vi.fn(), getSpots: vi.fn(), getTemplates: vi.fn() }));
vi.mock('~/server/assets.functions', () => ({ getAssets: vi.fn() }));

const ORG = 'org_1';
const entry = (id: string, takeover: boolean): ScheduleEntryView => ({
  id,
  playlistId: 'pls_main',
  target: 'org',
  groupId: null,
  screenId: null,
  priority: takeover ? 100 : 0,
  startDate: null,
  endDate: null,
  days: null,
  from: null,
  to: null,
  startsAt: takeover ? '2026-11-20T12:00:00.000Z' : null,
  endsAt: takeover ? '2026-11-20T13:00:00.000Z' : null,
  takeover,
  deleted: false,
  live: null,
  version: 1,
  published: false,
  draftChanged: true,
  publishedAt: null,
  createdAt: 0,
  updatedAt: 0,
});

/** What `publish` and `end_takeover` answer: publish v`revision` to one screen, after the one before. */
const published = (revision: number) => ({
  publish: { id: `pub_${revision}`, revision, screens: 1, previousId: `pub_${revision - 1}` },
  promoted: [],
  held: [],
  removed: [],
  removedDataSources: [],
  screens: [{ screenId: 'scr_1', outcome: 'updated', problems: [] }],
});

/** The publish toast as sonner holds it: its title and its action. */
const publishToast = () => {
  const t = toast.getToasts().find((t) => t.id === 'publish');
  return t && 'title' in t ? t : undefined;
};
const undoOf = () => publishToast()?.action;

let revision = 1;
beforeEach(() => {
  toast.dismiss();
  revision = 1;
  vi.mocked(callTool).mockImplementation(async () => published(++revision));
  vi.mocked(getPlaylists).mockResolvedValue({ playlists: [] } as never);
  vi.mocked(getSpots).mockResolvedValue({ spots: [] } as never);
});

function setup(entries: ScheduleEntryView[]) {
  vi.mocked(getSchedule).mockResolvedValue({ entries } as never);
  const queryClient = new QueryClient();
  const store = createStore<PublishingSlice>()((set, get) => createPublishingSlice(set as never, get as never, { router: {}, queryClient } as never));
  return store.getState();
}

describe('the publish toast', () => {
  it("offers Undo for a publish of schedule entries, and a takeover's toast after it does not keep it", async () => {
    const s = setup([entry('sch_breakfast', false)]);
    await s.publishSchedule(ORG);
    expect(publishToast()?.title).toBe('Published v2 to 1 screen');
    expect(undoOf()).toMatchObject({ label: 'Undo' });
    // Its Undo is kept until used or closed: no timer races a keyboard reaching it.
    expect(publishToast()).toMatchObject({ duration: Infinity, closeButton: true });

    await s.endTakeover(ORG, 'sch_flash');
    expect(vi.mocked(callTool)).toHaveBeenLastCalledWith('end_takeover', { scheduleEntryId: 'sch_flash' });
    expect(publishToast()?.title).toBe('Published v3 to 1 screen');
    expect(undoOf()).toBeUndefined();
    // Nothing to keep: it goes on its timer again, with no close button left from the one it replaced.
    expect(publishToast()).toMatchObject({ duration: 10_000, closeButton: false });
  });

  it('offers no Undo for a publish that starts a takeover, right after one that did', async () => {
    const s = setup([entry('sch_breakfast', false), entry('sch_flash', true)]);
    await s.publishSchedule(ORG, ['sch_breakfast']);
    expect(undoOf()).toMatchObject({ label: 'Undo' });
    await s.publishSchedule(ORG, ['sch_flash']);
    expect(publishToast()?.title).toBe('Published v3 to 1 screen');
    expect(undoOf()).toBeUndefined();
  });
});
