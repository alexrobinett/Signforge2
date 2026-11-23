// The publish toast (M3-19 review): each publish's toast replaces the last one, under one id, and
// sonner merges what it is given into the toast it replaces. So a takeover's toast, which offers no
// Undo, must still clear the Undo of the publish before it, whenever it comes. Read from sonner's
// own store, two publishes in a row, nothing on a timer. And one entry published alone (#181):
// what it pins.
import { QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { ScheduleEntryView } from '../src/lib/schedule';
import { callTool, Refusal } from '../src/lib/tools';
import { getPlaylists } from '../src/server/playlists.functions';
import { getSchedule } from '../src/server/schedule.functions';
import { getSpots, getTemplates } from '../src/server/spots.functions';
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

    await s.endTakeover(ORG, 'sch_flash');
    expect(vi.mocked(callTool)).toHaveBeenLastCalledWith('end_takeover', { scheduleEntryId: 'sch_flash' });
    expect(publishToast()?.title).toBe('Published v3 to 1 screen');
    expect(undoOf()).toBeUndefined();
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

describe('one entry published alone (#181)', () => {
  const list = (id: string, over: object) => ({ id, name: id, spotIds: [], version: 1, isDefault: false, published: true, draftChanged: false, ...over });
  const mine = { ...entry('sch_mine', false), playlistId: 'pls_holiday', target: 'screen' as const, screenId: 'scr_1', version: 4 };
  const theirs = { ...entry('sch_theirs', false), playlistId: 'pls_main' };

  it("pins the entry, with its playlist and the spots in it never published, and nobody else's drafts", async () => {
    vi.mocked(getPlaylists).mockResolvedValue({
      playlists: [
        list('pls_holiday', { published: false, draftChanged: true, version: 3, spotIds: ['spt_new', 'spt_old'] }),
        list('pls_main', { draftChanged: true }),
      ],
    } as never);
    vi.mocked(getSpots).mockResolvedValue({
      spots: [
        list('spt_new', { published: false, draftChanged: true, version: 2 }),
        list('spt_old', { draftChanged: true, version: 5 }),
        list('spt_else', { published: false }),
      ],
    } as never);
    const s = setup([mine, theirs]);
    await s.publishEntry(ORG, 'sch_mine');
    expect(vi.mocked(callTool)).toHaveBeenLastCalledWith('publish', {
      drafts: [
        { kind: 'schedule_entry', id: 'sch_mine', version: 4 },
        { kind: 'playlist', id: 'pls_holiday', version: 3 },
        { kind: 'spot', id: 'spt_new', version: 2 },
      ],
    });
    expect(undoOf()).toMatchObject({ label: 'Undo' });
  });

  it('pins the entry alone when its playlist was published: its edits since stay a draft', async () => {
    vi.mocked(getPlaylists).mockResolvedValue({ playlists: [list('pls_holiday', { draftChanged: true, spotIds: ['spt_new'] })] } as never);
    vi.mocked(getSpots).mockResolvedValue({ spots: [list('spt_new', { published: false })] } as never);
    const s = setup([mine]);
    await s.publishEntry(ORG, 'sch_mine');
    expect(vi.mocked(callTool)).toHaveBeenLastCalledWith('publish', { drafts: [{ kind: 'schedule_entry', id: 'sch_mine', version: 4 }] });
  });

  /** The toasts sonner holds, as title and description. */
  const said = () => toast.getToasts().flatMap((t) => ('title' in t ? [{ title: t.title, description: t.description }] : []));

  it('says the entry is saved as a draft when its publish is refused (#181 review)', async () => {
    vi.mocked(getPlaylists).mockResolvedValue({ playlists: [list('pls_holiday', {})] } as never);
    vi.mocked(callTool).mockRejectedValueOnce(new Refusal('forbidden', 'Only owners publish in this organization'));
    const s = setup([mine]);
    await s.publishEntry(ORG, 'sch_mine');
    expect(said()).toContainEqual({ title: 'Saved as a draft, not published', description: 'Only owners publish in this organization' });
  });

  it('says so too when the read before the publish fails, and publishes nothing', async () => {
    vi.mocked(getSchedule).mockRejectedValueOnce(new Refusal('network', 'Could not reach SignForge. Check your connection and try again.'));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const store = createStore<PublishingSlice>()((set, get) => createPublishingSlice(set as never, get as never, { router: {}, queryClient } as never));
    vi.mocked(callTool).mockClear();
    await store.getState().publishEntry(ORG, 'sch_mine');
    expect(said()).toContainEqual({ title: 'Saved as a draft, not published', description: 'Could not reach SignForge. Check your connection and try again.' });
    expect(vi.mocked(callTool)).not.toHaveBeenCalled();
  });
});

describe('a held publish (#253)', () => {
  const spot = { id: 'spt_6r26', name: 'Breakfast board', templateVersionId: 'tv_promo', published: false, draftChanged: true, version: 2 };
  const playlist = { id: 'pls_main', name: 'All day', spotIds: ['spt_6r26'], version: 1, isDefault: true, published: false, draftChanged: true };
  const promo = {
    key: 'photo-promo',
    versions: [
      {
        id: 'tv_promo',
        manifest: { fields: { photo: { type: 'image', label: 'Photo' }, showPhoto: { type: 'boolean', label: 'Show the photo', default: true } } },
      },
    ],
  };
  const held = (problem: string) => ({
    ...published(2),
    publish: null,
    held: [
      { kind: 'playlist', id: 'pls_main', problems: ['spot spt_6r26 is not published'] },
      { kind: 'spot', id: 'spt_6r26', problems: [`spot spt_6r26: ${problem}`] },
    ],
    screens: [],
  });
  /** The publish toast's title, description and action, as sonner holds them. */
  const heldToast = () => {
    const t = toast.getToasts().findLast((t) => 'title' in t && t.title === 'Not published');
    return t && 'title' in t ? { description: t.description, action: t.action } : undefined;
  };

  function setupHeld(problem: string) {
    vi.mocked(getSchedule).mockResolvedValue({ entries: [entry('sch_breakfast', false)] } as never);
    vi.mocked(getPlaylists).mockResolvedValue({ playlists: [playlist] } as never);
    vi.mocked(getSpots).mockResolvedValue({ spots: [spot] } as never);
    vi.mocked(getTemplates).mockResolvedValue({ templates: [promo] } as never);
    vi.mocked(callTool).mockResolvedValueOnce(held(problem) as never);
    const navigate = vi.fn();
    const store = createStore<PublishingSlice>()((set, get) =>
      createPublishingSlice(set as never, get as never, { router: { navigate }, queryClient: new QueryClient() } as never),
    );
    return { s: store.getState(), navigate };
  }

  it('names the spot that holds it back, says how to fix its photo, and links to it', async () => {
    const { s, navigate } = setupHeld('image field "photo" has no asset');
    await s.publishSchedule(ORG);
    const t = heldToast();
    expect(t?.description).toBe('Breakfast board has no image for Photo: choose one, or untick Show the photo.');
    expect(t?.action).toMatchObject({ label: 'Open Breakfast board' });
    const action = t?.action;
    if (action && typeof action === 'object' && 'onClick' in action) action.onClick({} as never);
    expect(navigate).toHaveBeenCalledWith({ to: '/spots/$spotId', params: { spotId: 'spt_6r26' } });
  });

  it("puts any other check in the spot's name, with no id", async () => {
    const { s } = setupHeld("duration 1000 ms is outside the template's range 4000 to 60000");
    await s.publishSchedule(ORG);
    expect(heldToast()?.description).toBe("Breakfast board does not pass its checks: duration 1000 ms is outside the template's range 4000 to 60000.");
  });

  it('says the problem as written when the names cannot be read, and never calls the publish refused', async () => {
    vi.mocked(getSpots).mockRejectedValue(new Refusal('network', 'Could not reach SignForge. Check your connection and try again.'));
    vi.mocked(callTool).mockResolvedValueOnce(held('image field "photo" has no asset') as never);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const store = createStore<PublishingSlice>()((set, get) => createPublishingSlice(set as never, get as never, { router: {}, queryClient } as never));
    await store.getState().endTakeover(ORG, 'sch_flash');
    expect(heldToast()?.description).toBe('It does not pass its checks: spot spt_6r26 is not published.');
  });
});
