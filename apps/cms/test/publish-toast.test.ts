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
import { getAssets } from '../src/server/assets.functions';
import { getBrandKits, getSpots, getTemplates } from '../src/server/spots.functions';
import { initialOrgs, type OrgsState } from '../src/state/orgs';
import { createPublishingSlice, type PublishingSlice } from '../src/state/publishing';

vi.mock('~/lib/tab-org', () => ({ tabOrgHeaders: async () => ({}) }));
vi.mock('~/lib/tools', async (original) => ({ ...(await original<typeof import('../src/lib/tools')>()), callTool: vi.fn() }));
vi.mock('~/server/schedule.functions', () => ({ getSchedule: vi.fn() }));
vi.mock('~/server/playlists.functions', () => ({ getPlaylists: vi.fn(), getPlaylist: vi.fn() }));
vi.mock('~/server/spots.functions', () => ({ getBrandKits: vi.fn(), getSpot: vi.fn(), getSpotPreview: vi.fn(), getSpots: vi.fn(), getTemplates: vi.fn() }));
vi.mock('~/server/assets.functions', () => ({ getAssets: vi.fn() }));

const ORG = 'org_1';

/** The publishing slice alone, on a page that shows `ORG` (`shown`, which a test changes to leave it), with no switch on its way. */
const shown = { org: ORG };
function publishingStore(deps: { router?: object; queryClient?: object }) {
  const router = {
    ...deps.router,
    state: {
      get matches() {
        return [{ routeId: '/_app', loaderData: { organization: { id: shown.org } } }];
      },
    },
  };
  return createStore<PublishingSlice & { closeScheduleDialog: () => void; orgs: OrgsState }>()((set, get) => ({
    closeScheduleDialog: vi.fn(),
    orgs: initialOrgs,
    ...createPublishingSlice(set as never, get as never, { ...deps, router } as never),
  }));
}
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

/** What `publish` and `takeover` answer: publish v`revision` to one screen, after the one before. */
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
  shown.org = ORG;
  toast.dismiss();
  revision = 1;
  vi.mocked(callTool).mockImplementation(async () => published(++revision) as never);
  vi.mocked(getPlaylists).mockResolvedValue({ playlists: [] } as never);
  vi.mocked(getSpots).mockResolvedValue({ spots: [] } as never);
});

function setup(entries: ScheduleEntryView[]) {
  vi.mocked(getSchedule).mockResolvedValue({ entries } as never);
  const queryClient = new QueryClient();
  const store = publishingStore({ router: {}, queryClient });
  return store.getState();
}

/** The publish of the entry with its default, never published, pinned: only while it is still the default (#393). */
const pinnedDefault = {
  ifDefault: 'pls_all_day',
  drafts: [
    { kind: 'schedule_entry', id: 'sch_mine', version: 4 },
    { kind: 'playlist', id: 'pls_all_day', version: 2 },
    { kind: 'spot', id: 'spt_open', version: 3 },
  ],
};

describe('the publish toast', () => {
  it("offers Undo for a publish of schedule entries, and a takeover's toast after it does not keep it", async () => {
    const s = setup([entry('sch_breakfast', false)]);
    await s.publishSchedule(ORG);
    expect(publishToast()?.title).toBe('Published v2 to 1 screen');
    expect(undoOf()).toMatchObject({ label: 'Undo' });

    await s.endTakeover(ORG, 'sch_flash');
    expect(vi.mocked(callTool)).toHaveBeenLastCalledWith('takeover', { action: 'end', scheduleEntryId: 'sch_flash' });
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
    expect(vi.mocked(callTool)).toHaveBeenLastCalledWith(
      'publish',
      {
        drafts: [
          { kind: 'schedule_entry', id: 'sch_mine', version: 4 },
          { kind: 'playlist', id: 'pls_holiday', version: 3 },
          { kind: 'spot', id: 'spt_new', version: 2 },
        ],
      },
      ORG,
    );
    expect(undoOf()).toMatchObject({ label: 'Undo' });
  });

  it('pins the entry alone when its playlist was published: its edits since stay a draft', async () => {
    vi.mocked(getPlaylists).mockResolvedValue({ playlists: [list('pls_holiday', { draftChanged: true, spotIds: ['spt_new'] })] } as never);
    vi.mocked(getSpots).mockResolvedValue({ spots: [list('spt_new', { published: false })] } as never);
    const s = setup([mine]);
    await s.publishEntry(ORG, 'sch_mine');
    expect(vi.mocked(callTool)).toHaveBeenLastCalledWith('publish', { drafts: [{ kind: 'schedule_entry', id: 'sch_mine', version: 4 }] }, ORG);
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
    const store = publishingStore({ router: {}, queryClient });
    vi.mocked(callTool).mockClear();
    await store.getState().publishEntry(ORG, 'sch_mine');
    expect(said()).toContainEqual({ title: 'Saved as a draft, not published', description: 'Could not reach SignForge. Check your connection and try again.' });
    expect(vi.mocked(callTool)).not.toHaveBeenCalled();
  });
});

describe('the default chosen before a publish, with none yet (#243)', () => {
  const list = (id: string, over: object) => ({ id, name: id, spotIds: [], version: 1, isDefault: false, published: true, draftChanged: false, ...over });
  const mine = { ...entry('sch_mine', false), playlistId: 'pls_holiday', target: 'screen' as const, screenId: 'scr_1', version: 4 };
  const names = () => vi.mocked(callTool).mock.calls.map(([name]) => name);
  /** `name` refused with `err`; every other call answered as in `beforeEach`. */
  const refuse = (name: string, err: Refusal) => {
    const answer = vi.mocked(callTool).getMockImplementation()!;
    vi.mocked(callTool).mockImplementation(async (called, input) => {
      if (called === name) throw err;
      return answer(called, input);
    });
  };
  const said = () => toast.getToasts().flatMap((t) => ('title' in t ? [{ title: t.title, description: t.description }] : []));

  it('pins a default never published only when its box was ticked: a retry after a publish that failed once it was set (#336); never a dialog choice it did not show, nor from the agent drawer (#393)', async () => {
    vi.mocked(getPlaylists).mockResolvedValue({
      playlists: [list('pls_holiday', {}), list('pls_all_day', { isDefault: true, published: false, version: 2, spotIds: ['spt_open'] })],
    } as never);
    vi.mocked(getSpots).mockResolvedValue({ spots: [list('spt_open', { published: false, version: 3 })] } as never);
    const alone = [['publish', { drafts: [{ kind: 'schedule_entry', id: 'sch_mine', version: 4 }] }, ORG]];
    // Ticked: "Publish All day too".
    vi.mocked(callTool).mockClear();
    await setup([mine]).publishEntry(ORG, 'sch_mine', { publishDefault: true });
    expect(names()).toEqual(['publish']);
    expect(vi.mocked(callTool)).toHaveBeenLastCalledWith('publish', pinnedDefault, ORG);
    // Confirmed for its own playlist, the box left unticked: the entry alone, whatever choice the dialog carried.
    for (const withDefault of [{}, { choice: 'pls_holiday' }, { choice: 'pls_holiday', publishDefault: false }]) {
      vi.mocked(callTool).mockClear();
      await setup([mine]).publishEntry(ORG, 'sch_mine', withDefault);
      expect(vi.mocked(callTool).mock.calls, JSON.stringify(withDefault)).toEqual(alone);
    }
    // A takeover's dialog the same.
    vi.mocked(callTool).mockClear();
    await setup([mine]).publishSchedule(ORG, ['sch_mine'], { choice: 'pls_holiday' });
    expect(vi.mocked(callTool).mock.calls[0]?.[1]).not.toHaveProperty('ifDefault');
    expect(JSON.stringify(vi.mocked(callTool).mock.calls)).not.toContain('pls_all_day');
    // As the drawer calls it (agent-drawer.ts publishDrafts), with no default choice: the entry alone.
    vi.mocked(callTool).mockClear();
    await setup([mine]).publishEntry(ORG, 'sch_mine');
    expect(vi.mocked(callTool).mock.calls).toEqual(alone);
  });

  it('says the default was set when the publish after it fails (#336)', async () => {
    vi.mocked(getPlaylists).mockResolvedValue({ playlists: [list('pls_holiday', {}), list('pls_all_day', { published: false, version: 2 })] } as never);
    vi.mocked(callTool).mockClear();
    refuse('publish', new Refusal('conflict', 'schedule entry sch_mine has changed', { id: 'sch_mine', version: 5 }));
    await setup([mine]).publishEntry(ORG, 'sch_mine', { choice: 'pls_all_day' });
    expect(said()).toContainEqual({
      title: 'Saved as a draft, not published',
      description: 'pls_all_day is now the default playlist. It changed since you opened it, perhaps in another tab. Reload and publish again.',
    });
  });

  it('sets no default when the entry is no longer there, and publishes nothing (#336)', async () => {
    vi.mocked(getPlaylists).mockResolvedValue({ playlists: [list('pls_all_day', { published: false })] } as never);
    vi.mocked(callTool).mockClear();
    await setup([]).publishEntry(ORG, 'sch_mine', { choice: 'pls_all_day' });
    expect(names()).toEqual([]);
    // Gone, so not kept as a draft either.
    expect(said()).toContainEqual({ title: 'Not published', description: 'The entry is no longer there: someone may have removed it.' });
  });

  it('replaces no default someone chose since the lists were read: set only while there is none, nothing is published (#393)', async () => {
    vi.mocked(getPlaylists).mockResolvedValue({ playlists: [list('pls_holiday', {})] } as never);
    vi.mocked(callTool).mockClear();
    refuse('set_default_playlist', new Refusal('conflict', 'the default playlist is now pls_theirs', { defaultPlaylistId: 'pls_theirs' }));
    await setup([mine]).publishEntry(ORG, 'sch_mine', { choice: 'pls_holiday' });
    expect(names()).toEqual(['set_default_playlist']);
    expect(vi.mocked(callTool)).toHaveBeenLastCalledWith('set_default_playlist', { playlistId: 'pls_holiday', ifDefault: null });
    expect(said()).toContainEqual({
      title: 'Saved as a draft, not published',
      description: 'Someone chose a default playlist meanwhile. Reload to see it, then publish again.',
    });
  });

  it('says the default stays set when the publish after it is held back (#393)', async () => {
    vi.mocked(getPlaylists).mockResolvedValue({ playlists: [list('pls_holiday', {}), list('pls_all_day', { published: false, version: 2 })] } as never);
    vi.mocked(callTool).mockClear();
    const answer = vi.mocked(callTool).getMockImplementation()!;
    vi.mocked(callTool).mockImplementation(async (name, input) =>
      name === 'publish'
        ? ({
            ...published(++revision),
            publish: null,
            promoted: [],
            held: [{ kind: 'playlist', id: 'pls_all_day', problems: ['spot spt_x is not published'] }],
          } as never)
        : answer(name, input),
    );
    await setup([mine]).publishEntry(ORG, 'sch_mine', { choice: 'pls_all_day' });
    // The latest of its title: an earlier test's may still be listed.
    expect(said().findLast((t) => t.title === 'Saved as a draft, not published')?.description).toMatch(/^pls_all_day is now the default playlist\. /);
  });

  it("says the default moved, in plain words and without saying it set one, when publish's ifDefault is refused (#393)", async () => {
    const moved = new Refusal('conflict', 'the default playlist is now pls_other', { defaultPlaylistId: 'pls_other' });
    const plain = { title: 'Saved as a draft, not published', description: 'Someone changed the default playlist. Reload to see it.' };
    // Set on the way, then switched by someone else before the publish.
    vi.mocked(getPlaylists).mockResolvedValue({ playlists: [list('pls_holiday', {}), list('pls_all_day', { published: false, version: 2 })] } as never);
    refuse('publish', moved);
    toast.dismiss();
    await setup([mine]).publishEntry(ORG, 'sch_mine', { choice: 'pls_all_day' });
    expect(said().findLast((t) => t.title === plain.title)).toEqual(plain);
    // Already the default, never published, and switched since it was read.
    vi.mocked(getPlaylists).mockResolvedValue({
      playlists: [list('pls_holiday', {}), list('pls_all_day', { isDefault: true, published: false, version: 2 })],
    } as never);
    toast.dismiss();
    await setup([mine]).publishEntry(ORG, 'sch_mine', { publishDefault: true });
    expect(said().findLast((t) => t.title === plain.title)).toEqual(plain);
  });

  it('says only that something changed when a publish gives up on a conflict that names none of its pins, never that its default is still set (round 3 of #393)', async () => {
    vi.mocked(getPlaylists).mockResolvedValue({ playlists: [list('pls_holiday', {}), list('pls_all_day', { published: false, version: 2 })] } as never);
    refuse('publish', new Refusal('conflict', 'default_playlist has changed since you read it', { id: 'default_playlist', version: 7 }));
    toast.dismiss();
    await setup([mine]).publishEntry(ORG, 'sch_mine', { choice: 'pls_all_day' });
    expect(said().findLast((t) => t.title === 'Saved as a draft, not published')?.description).toBe(
      'Something changed while publishing. Reload and try again.',
    );
  });

  it('says the default stays set when the publish after it reaches no screen, or has nothing to publish (#393)', async () => {
    vi.mocked(getPlaylists).mockResolvedValue({ playlists: [list('pls_holiday', {}), list('pls_all_day', { published: false, version: 2 })] } as never);
    const answer = vi.mocked(callTool).getMockImplementation()!;
    const nothing = (screens: object[]) =>
      vi
        .mocked(callTool)
        .mockImplementation(async (name, input) =>
          name === 'publish' ? ({ ...published(++revision), publish: null, promoted: [], held: [], screens } as never) : answer(name, input),
        );
    nothing([{ screenId: 'scr_1', outcome: 'failed', problems: ['its storage is full'] }]);
    await setup([mine]).publishEntry(ORG, 'sch_mine', { choice: 'pls_all_day' });
    expect(said().findLast((t) => t.title === 'No screen can play it yet')?.description).toBe(
      'pls_all_day is now the default playlist. Every screen keeps what it plays: its storage is full.',
    );
    nothing([]);
    await setup([mine]).publishEntry(ORG, 'sch_mine', { choice: 'pls_all_day' });
    expect(said().findLast((t) => t.title === 'Nothing to publish')?.description).toBe(
      'pls_all_day is now the default playlist. Every screen already plays this.',
    );
  });

  it('sets no default and publishes nothing when an entry asked for is gone, removed in another tab (#393)', async () => {
    vi.mocked(getPlaylists).mockResolvedValue({ playlists: [list('pls_all_day', { published: false })] } as never);
    vi.mocked(callTool).mockClear();
    await setup([mine]).publishSchedule(ORG, ['sch_mine', 'sch_gone'], { choice: 'pls_all_day' });
    expect(names()).toEqual([]);
    expect(said()).toContainEqual({ title: 'Not published', description: 'An entry is no longer there: someone may have removed it. Reload and look again.' });
  });

  it('makes it the default first, then publishes it too when it was never published', async () => {
    vi.mocked(getPlaylists).mockResolvedValue({
      playlists: [list('pls_holiday', {}), list('pls_all_day', { published: false, version: 2, spotIds: ['spt_open'] })],
    } as never);
    vi.mocked(getSpots).mockResolvedValue({ spots: [list('spt_open', { published: false, version: 3 })] } as never);
    vi.mocked(callTool).mockClear();
    await setup([mine]).publishEntry(ORG, 'sch_mine', { choice: 'pls_all_day' });
    expect(names()).toEqual(['set_default_playlist', 'publish']);
    expect(vi.mocked(callTool)).toHaveBeenNthCalledWith(1, 'set_default_playlist', { playlistId: 'pls_all_day', ifDefault: null });
    expect(vi.mocked(callTool)).toHaveBeenLastCalledWith('publish', pinnedDefault, ORG);
  });

  it('pins its own playlist once when the default chosen is it', async () => {
    vi.mocked(getPlaylists).mockResolvedValue({ playlists: [list('pls_holiday', { published: false, version: 3 })] } as never);
    vi.mocked(getSpots).mockResolvedValue({ spots: [] } as never);
    vi.mocked(callTool).mockClear();
    await setup([mine]).publishEntry(ORG, 'sch_mine', { choice: 'pls_holiday' });
    expect(vi.mocked(callTool)).toHaveBeenLastCalledWith(
      'publish',
      {
        ifDefault: 'pls_holiday',
        drafts: [
          { kind: 'schedule_entry', id: 'sch_mine', version: 4 },
          { kind: 'playlist', id: 'pls_holiday', version: 3 },
        ],
      },
      ORG,
    );
  });

  it('publishes without one when none was chosen, or the org has one since', async () => {
    vi.mocked(getSpots).mockResolvedValue({ spots: [] } as never);
    vi.mocked(getPlaylists).mockResolvedValue({ playlists: [list('pls_holiday', {})] } as never);
    vi.mocked(callTool).mockClear();
    await setup([mine]).publishEntry(ORG, 'sch_mine', {});
    expect(names()).toEqual(['publish']);

    vi.mocked(getPlaylists).mockResolvedValue({ playlists: [list('pls_holiday', {}), list('pls_main', { isDefault: true })] } as never);
    vi.mocked(callTool).mockClear();
    await setup([mine]).publishEntry(ORG, 'sch_mine', { choice: 'pls_holiday' });
    expect(names()).toEqual(['publish']);
  });

  it('publishes nothing when making it the default is refused, and says the entry is a draft', async () => {
    vi.mocked(getPlaylists).mockResolvedValue({ playlists: [list('pls_holiday', {})] } as never);
    vi.mocked(getSpots).mockResolvedValue({ spots: [] } as never);
    vi.mocked(callTool).mockClear();
    refuse('set_default_playlist', new Refusal('forbidden', 'Only owners publish in this organization'));
    await setup([mine]).publishEntry(ORG, 'sch_mine', { choice: 'pls_holiday' });
    expect(names()).toEqual(['set_default_playlist']);
    const said = toast.getToasts().flatMap((t) => ('title' in t ? [{ title: t.title, description: t.description }] : []));
    expect(said).toContainEqual({ title: 'Saved as a draft, not published', description: 'Only owners publish in this organization' });
  });
});

describe('a held publish (#253)', () => {
  const spot = { id: 'spt_6r26', name: 'Breakfast board', templateVersionId: 'tv_promo', published: false, draftChanged: true, version: 2 };
  const playlist = { id: 'pls_main', name: 'All day', spotIds: ['spt_6r26'], version: 1, isDefault: true, published: false, draftChanged: true };
  const promo = {
    key: 'photo-promo',
    name: 'Photo Promo',
    versions: [
      {
        id: 'tv_promo',
        version: '1.4.0',
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
    return t && 'title' in t ? { description: t.description, action: t.action, duration: t.duration } : undefined;
  };

  function setupHeld(problem: string) {
    vi.mocked(getSchedule).mockResolvedValue({ entries: [entry('sch_breakfast', false)] } as never);
    vi.mocked(getPlaylists).mockResolvedValue({ playlists: [playlist] } as never);
    vi.mocked(getSpots).mockResolvedValue({ spots: [spot] } as never);
    vi.mocked(getTemplates).mockResolvedValue({ templates: [promo] } as never);
    vi.mocked(callTool).mockResolvedValueOnce(held(problem) as never);
    const navigate = vi.fn();
    const store = publishingStore({ router: { navigate }, queryClient: new QueryClient() });
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

  it('stays 10 s, as the success toast does: it carries a button (#253 review)', async () => {
    const { s } = setupHeld('image field "photo" has no asset');
    await s.publishSchedule(ORG);
    expect(heldToast()?.duration).toBe(10_000);
  });

  it('names the brand kit, the template version and the image a problem is about', async () => {
    vi.mocked(getBrandKits).mockResolvedValue({ brandKits: [{ id: 'bk_9', name: 'Harbor house style' }] } as never);
    const { s } = setupHeld('brand: brand kit bk_9 is not available');
    await s.publishSchedule(ORG);
    expect(heldToast()?.description).toBe('Breakfast board does not pass its checks: Harbor house style is not available.');

    vi.mocked(getAssets).mockResolvedValue({ assets: [{ id: 'ast_7', name: 'pumpkin-latte.png' }] } as never);
    const again = setupHeld('asset ast_7 does not exist');
    await again.s.publishSchedule(ORG);
    expect(heldToast()?.description).toBe('Breakfast board does not pass its checks: pumpkin-latte.png does not exist.');

    const third = setupHeld('template version tv_promo does not exist');
    await third.s.publishSchedule(ORG);
    expect(heldToast()?.description).toBe('Breakfast board does not pass its checks: Photo Promo 1.4.0 does not exist.');
  });

  /** The store over a Query client that retries, as a browser's does (with no delay: no clock): the name reads must turn that off themselves. */
  function namesFail() {
    const down = new Refusal('network', 'Could not reach SignForge. Check your connection and try again.');
    for (const read of [getSpots, getPlaylists, getTemplates, getBrandKits, getAssets])
      vi.mocked(read)
        .mockClear()
        .mockRejectedValue(down as never);
    const store = publishingStore({
      router: { navigate: vi.fn() },
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: 3, retryDelay: 0 } } }),
    });
    return store.getState();
  }

  it('says it in plain words, with no id, when the names cannot be read, and reads each once, not again', async () => {
    const s = namesFail();
    vi.mocked(callTool).mockResolvedValueOnce(held('brand: brand kit bk_9 is not available') as never);
    await s.endTakeover(ORG, 'sch_flash');
    expect(heldToast()?.description).toBe('This spot does not pass its checks: its brand kit is not available.');
    expect(vi.mocked(getSpots)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getBrandKits)).toHaveBeenCalledTimes(1);
  });

  it('says a publish that went through was published, and what it held back, when the names cannot be read', async () => {
    const s = namesFail();
    vi.mocked(callTool).mockResolvedValueOnce({
      ...held('image field "photo" has no asset'),
      publish: published(4).publish,
      screens: published(4).screens,
    } as never);
    const refusals = () => toast.getToasts().filter((x) => 'title' in x && x.title === 'Not published').length;
    const before = refusals();
    await s.endTakeover(ORG, 'sch_flash');
    const t = publishToast();
    expect(t?.title).toBe('Published v4 to 1 screen');
    expect(t?.description).toBe(
      'Each screen switches as it hears of it; the rollout says why any wait. Held back: This spot has no image for photo: choose one.',
    );
    expect(refusals()).toBe(before);
  });
});

describe('sample text the server refuses (#360)', () => {
  const refusal = () =>
    new Refusal('sample_text', 'still holding sample text', { spots: [{ id: 'spt_pier', name: 'Pier 9', version: 3, fields: ['headline', 'body'] }] });
  const PIER_ACK = { spotId: 'spt_pier', version: 3, fields: ['headline', 'body'] };
  /** A schedule publish the server refuses once for sample text, then publishes. */
  function refusedOnce() {
    vi.mocked(getSchedule).mockResolvedValue({ entries: [entry('sch_breakfast', false)] } as never);
    vi.mocked(getPlaylists).mockResolvedValue({ playlists: [] } as never);
    vi.mocked(getSpots).mockResolvedValue({ spots: [] } as never);
    vi.mocked(callTool)
      .mockReset()
      .mockRejectedValueOnce(refusal())
      .mockImplementation(async () => published(++revision));
    const navigate = vi.fn();
    return { store: publishingStore({ router: { navigate }, queryClient: new QueryClient() }), navigate };
  }
  const asked = (store: ReturnType<typeof publishingStore>) => vi.waitFor(() => expect(store.getState().publishing.sampleCheck).not.toBeNull());

  it('asks, naming the fields, and Publish anyway sends it again acknowledging exactly that spot, version and fields', async () => {
    const { store } = refusedOnce();
    const done = store.getState().publishSchedule(ORG);
    await asked(store);
    // The templates could not be read here: the fields are named as they are.
    expect(store.getState().publishing.sampleCheck?.words).toBe('In Pier 9, headline and body still have sample text.');
    store.getState().publishAnyway();
    expect(await done).toBe(true);
    expect(vi.mocked(callTool)).toHaveBeenLastCalledWith(
      'publish',
      {
        drafts: [{ kind: 'schedule_entry', id: 'sch_breakfast', version: 1 }],
        allowSample: [PIER_ACK],
      },
      ORG,
    );
    expect(store.getState().publishing.sampleCheck).toBeNull();
  });

  it('opens no question once the org is left while it read the templates: the publish waiting on it stops (review of #472)', async () => {
    const { store } = refusedOnce();
    let release: (v: unknown) => void = () => {};
    vi.mocked(getTemplates).mockImplementationOnce(() => new Promise((r) => (release = r)) as never);
    const done = store.getState().publishSchedule(ORG);
    await vi.waitFor(() => expect(getTemplates).toHaveBeenCalled());
    shown.org = 'org_2';
    release({ templates: [] });
    expect(await done).toBe(false);
    expect(store.getState().publishing.sampleCheck).toBeNull();
    expect(vi.mocked(callTool)).toHaveBeenCalledTimes(1);
  });

  it('refused again for a spot it did not acknowledge, asks about that one and sends both', async () => {
    const { store } = refusedOnce();
    vi.mocked(callTool)
      .mockReset()
      .mockRejectedValueOnce(refusal())
      .mockRejectedValueOnce(new Refusal('sample_text', 'still', { spots: [{ id: 'spt_dock', name: 'Dock', version: 1, fields: ['title'] }] }))
      .mockImplementation(async () => published(++revision));
    const done = store.getState().publishSchedule(ORG);
    await asked(store);
    store.getState().publishAnyway();
    await vi.waitFor(() => expect(store.getState().publishing.sampleCheck?.spotId).toBe('spt_dock'));
    store.getState().publishAnyway();
    expect(await done).toBe(true);
    expect(vi.mocked(callTool).mock.calls.at(-1)?.[1]).toMatchObject({ allowSample: [PIER_ACK, { spotId: 'spt_dock', version: 1, fields: ['title'] }] });
  });

  it('Edit first sends nothing more, says not published, and opens the spot; Escape only lets it go', async () => {
    const { store, navigate } = refusedOnce();
    const done = store.getState().publishSchedule(ORG);
    await asked(store);
    await store.getState().editFirst();
    expect(await done).toBe(false);
    expect(vi.mocked(callTool)).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith({ to: '/spots/$spotId', params: { spotId: 'spt_pier' } });
    // A schedule dialog that asked goes too.
    expect(store.getState().closeScheduleDialog).toHaveBeenCalled();

    vi.mocked(callTool).mockReset().mockRejectedValueOnce(refusal());
    const again = store.getState().publishSchedule(ORG);
    await asked(store);
    store.getState().dropSampleCheck();
    expect(await again).toBe(false);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('with a default to set first, asks before anything is written: Edit first changes nothing (finding 4)', async () => {
    vi.mocked(getSchedule).mockResolvedValue({ entries: [entry('sch_breakfast', false)] } as never);
    vi.mocked(getPlaylists).mockResolvedValue({
      playlists: [{ id: 'pls_main', name: 'Main', version: 2, spotIds: ['spt_pier'], isDefault: false, published: false, draftChanged: true }],
    } as never);
    vi.mocked(getSpots).mockResolvedValue({
      spots: [{ id: 'spt_pier', name: 'Pier 9', version: 3, published: false, draftChanged: true, sampleFields: { texts: ['headline'], lists: {} } }],
    } as never);
    vi.mocked(callTool)
      .mockReset()
      .mockImplementation(async () => published(++revision));
    const store = publishingStore({ router: { navigate: vi.fn() }, queryClient: new QueryClient() });
    const done = store.getState().publishSchedule(ORG, ['sch_breakfast'], { choice: 'pls_main' });
    await asked(store);
    await store.getState().editFirst();
    expect(await done).toBe(false);
    expect(vi.mocked(callTool)).not.toHaveBeenCalled();

    // Publish anyway: the default is set, then the publish goes, allowed.
    const yes = store.getState().publishSchedule(ORG, ['sch_breakfast'], { choice: 'pls_main' });
    await asked(store);
    store.getState().publishAnyway();
    expect(await yes).toBe(true);
    expect(vi.mocked(callTool).mock.calls.map((c) => c[0])).toEqual(['set_default_playlist', 'publish']);
    expect(vi.mocked(callTool).mock.calls[1]?.[1]).toMatchObject({ allowSample: [{ spotId: 'spt_pier', version: 3, fields: ['headline'] }] });
  });

  it('before a schedule dialog saves, asks once about its playlist’s spots and the default it would publish', async () => {
    const sample = (id: string, name: string) => ({
      id,
      name,
      version: 2,
      published: false,
      draftChanged: true,
      sampleFields: { texts: ['headline'], lists: {} },
    });
    vi.mocked(getSchedule).mockResolvedValue({ entries: [] } as never);
    vi.mocked(getPlaylists).mockResolvedValue({
      playlists: [
        { id: 'pls_flash', version: 1, spotIds: ['spt_pier'], isDefault: false, published: true, draftChanged: false },
        { id: 'pls_clean', version: 1, spotIds: [], isDefault: false, published: true, draftChanged: false },
        { id: 'pls_home', version: 1, spotIds: ['spt_home'], isDefault: false, published: false, draftChanged: true },
      ],
    } as never);
    vi.mocked(getSpots).mockResolvedValue({ spots: [sample('spt_pier', 'Pier 9'), sample('spt_home', 'Home')] } as never);
    vi.mocked(callTool).mockReset();
    const store = publishingStore({ router: { navigate: vi.fn() }, queryClient: new QueryClient() });
    const would = (playlistId: string, choice?: string) => ({ playlistId, alone: false, withDefault: { choice }, refused: 'Not started' });
    expect(await store.getState().checkSampleText(ORG, would('pls_clean'))).toEqual([]);
    const cancelled = store.getState().checkSampleText(ORG, would('pls_flash', 'pls_home'));
    await asked(store);
    expect(store.getState().publishing.sampleCheck?.words).toContain('Pier 9');
    expect(store.getState().publishing.sampleCheck?.words).toContain('Home');
    store.getState().dropSampleCheck();
    expect(await cancelled).toBeNull();
    const allowed = store.getState().checkSampleText(ORG, would('pls_flash', 'pls_home'));
    await asked(store);
    store.getState().publishAnyway();
    expect((await allowed)?.map((s) => [s.id, s.version])).toEqual([
      ['spt_pier', 2],
      ['spt_home', 2],
    ]);
    // Nothing is written by asking.
    expect(vi.mocked(callTool)).not.toHaveBeenCalled();
  });

  it('a check started while one is on its way starts nothing: a second click asks nothing and reads nothing', async () => {
    vi.mocked(getSchedule).mockResolvedValue({ entries: [] } as never);
    vi.mocked(getPlaylists).mockResolvedValue({ playlists: [] } as never);
    vi.mocked(getSpots).mockResolvedValue({ spots: [] } as never);
    const store = publishingStore({ router: { navigate: vi.fn() }, queryClient: new QueryClient() });
    const would = { playlistId: 'pls_none', alone: true, withDefault: {}, refused: 'Not saved' };
    const first = store.getState().checkSampleText(ORG, would);
    expect(await store.getState().checkSampleText(ORG, would)).toBeNull();
    expect(await first).toEqual([]);
    expect(store.getState().publishing.pending).toBe(false);
  });

  it('sends nothing for an org the tab has left, as a drawer Publish answered after a switch (#479)', async () => {
    vi.mocked(getSchedule).mockResolvedValue({ entries: [entry('sch_breakfast', false)] } as never);
    vi.mocked(getPlaylists).mockResolvedValue({ playlists: [] } as never);
    vi.mocked(getSpots).mockResolvedValue({ spots: [] } as never);
    vi.mocked(callTool)
      .mockReset()
      .mockImplementation(async () => published(++revision));
    const store = publishingStore({ router: { navigate: vi.fn() }, queryClient: new QueryClient() });
    shown.org = 'org_2';
    expect(await store.getState().publishTogether(ORG, [{ kind: 'schedule_entry', id: 'sch_breakfast' }])).toBe(false);
    expect(callTool).not.toHaveBeenCalled();
    // Said, as the sidebar's Publish says it, not refused in silence (#495).
    expect(toast.getToasts().findLast((t) => 'title' in t && t.title === 'Not published')).toMatchObject({
      description: 'The organization is changing. Publish once it shows.',
    });
  });

  it('says not published when the publish was held back: no publish was made', async () => {
    vi.mocked(getSchedule).mockResolvedValue({ entries: [entry('sch_breakfast', false)] } as never);
    vi.mocked(getPlaylists).mockResolvedValue({ playlists: [] } as never);
    vi.mocked(getSpots).mockResolvedValue({ spots: [] } as never);
    vi.mocked(callTool)
      .mockReset()
      .mockResolvedValue({ ...published(++revision), publish: null, screens: [] } as never);
    const store = publishingStore({ router: { navigate: vi.fn() }, queryClient: new QueryClient() });
    expect(await store.getState().publishTogether(ORG, [{ kind: 'schedule_entry', id: 'sch_breakfast' }])).toBe(false);
  });

  it('publishes the agent’s drafts together, after one question, or nothing', async () => {
    vi.mocked(getSchedule).mockResolvedValue({ entries: [{ ...entry('sch_new', false), playlistId: 'pls_flash' }] } as never);
    vi.mocked(getPlaylists).mockResolvedValue({
      playlists: [{ id: 'pls_flash', version: 1, spotIds: ['spt_pier'], isDefault: true, published: true, draftChanged: false }],
    } as never);
    vi.mocked(getSpots).mockResolvedValue({
      spots: [{ id: 'spt_pier', name: 'Pier 9', version: 4, published: true, draftChanged: true, sampleFields: { texts: ['headline'], lists: {} } }],
    } as never);
    vi.mocked(callTool)
      .mockReset()
      .mockImplementation(async () => published(++revision));
    const store = publishingStore({ router: { navigate: vi.fn() }, queryClient: new QueryClient() });
    Object.assign(store.getState(), { saveSpotDraft: vi.fn(), spotEditor: { drafts: {} } });
    const items = [
      { kind: 'spot', id: 'spt_pier' },
      { kind: 'schedule_entry', id: 'sch_new' },
    ] as const;
    const no = store.getState().publishTogether(ORG, items);
    await asked(store);
    store.getState().dropSampleCheck();
    expect(await no).toBe(false);
    expect(vi.mocked(callTool)).not.toHaveBeenCalled();

    const yes = store.getState().publishTogether(ORG, items);
    await asked(store);
    store.getState().publishAnyway();
    expect(await yes).toBe(true);
    expect(vi.mocked(callTool).mock.calls).toEqual([
      [
        'publish',
        {
          drafts: [
            { kind: 'spot', id: 'spt_pier', version: 4 },
            { kind: 'schedule_entry', id: 'sch_new', version: 1 },
          ],
          allowSample: [{ spotId: 'spt_pier', version: 4, fields: ['headline'] }],
        },
        ORG,
      ],
    ]);
  });
});

describe("the sidebar's Publish (#361)", () => {
  const ORG_ROUTER = { navigate: vi.fn(), state: { matches: [{ routeId: '/_app', loaderData: { organization: { id: ORG } } }] } };
  type Orgs = { switchingTo: string | null; drafts: Record<string, { pending: boolean }> };
  /** The publishing slice on a page of org_1, `switchingTo` the tab's own switch on its way, or null; `creating` an org being made. */
  function sidebarStore(switchingTo: string | null = null, creating = false) {
    return createStore<PublishingSlice & { orgs: Orgs }>()((set, get) => ({
      ...createPublishingSlice(set as never, get as never, { router: ORG_ROUTER, queryClient: new QueryClient() } as never),
      orgs: { switchingTo, drafts: { dialog: { pending: creating } } },
    }));
  }
  const spot = (id: string, version: number, over: object = {}) => ({ id, name: id, version, draftChanged: true, published: false, ...over });
  /** What the drafts read answers: spots, and the rest empty. */
  function drafts(spots: object[], playlists: object[] = [], entries: ScheduleEntryView[] = []) {
    vi.mocked(getSpots).mockResolvedValue({ spots } as never);
    vi.mocked(getPlaylists).mockResolvedValue({ playlists } as never);
    vi.mocked(getSchedule).mockResolvedValue({ entries } as never);
  }
  /** What `preview_publish` answers (#187), unless a test says otherwise: no screen would change. */
  let preview: object = { screens: [], unchanged: 1, failed: [], groups: [], samples: [] };
  beforeEach(() => {
    preview = { screens: [], unchanged: 1, failed: [], groups: [], samples: [] };
    vi.mocked(callTool)
      .mockReset()
      .mockImplementation(async (name: string) => (name === 'preview_publish' ? preview : published(++revision)) as never);
  });
  /** The calls made but the preview read beside the drafts. */
  const sent = () => vi.mocked(callTool).mock.calls.filter(([name]) => name !== 'preview_publish');

  it('publishes exactly what it read and showed, at those versions, naming the org it read', async () => {
    drafts([spot('spt_a', 3), spot('spt_b', 1, { draftChanged: false })]);
    const store = sidebarStore();
    await store.getState().askPublishAll(ORG);
    expect(store.getState().publishing.all).toMatchObject({ pins: [{ kind: 'spot', id: 'spt_a', version: 3 }], counts: { spots: 1 } });
    // Edited and added since it was read: neither is what was shown.
    drafts([spot('spt_a', 4), spot('spt_new', 1)]);
    expect(await store.getState().confirmPublishAll()).toBe(true);
    expect(sent()).toEqual([['publish', { drafts: [{ kind: 'spot', id: 'spt_a', version: 3 }] }, ORG]]);
  });

  it('fails, publishing nothing, when a draft it showed was edited since: the server refuses the old version', async () => {
    drafts([spot('spt_a', 3)]);
    const store = sidebarStore();
    await store.getState().askPublishAll(ORG);
    vi.mocked(callTool)
      .mockReset()
      .mockRejectedValueOnce(new Refusal('conflict', 'changed', { id: 'spt_a', version: 4 }));
    expect(await store.getState().confirmPublishAll()).toBe(false);
  });

  it('Cancel while it reads: the read lands on nothing, and nothing is published', async () => {
    let answer!: (v: unknown) => void;
    vi.mocked(getSpots).mockImplementation(() => new Promise((r) => (answer = r)) as never);
    vi.mocked(getPlaylists).mockResolvedValue({ playlists: [] } as never);
    vi.mocked(getSchedule).mockResolvedValue({ entries: [] } as never);
    const store = sidebarStore();
    const asking = store.getState().askPublishAll(ORG);
    expect(store.getState().publishing.all).toMatchObject({ pins: null });
    store.getState().cancelPublishAll();
    answer({ spots: [spot('spt_a', 3)] });
    await asking;
    expect(store.getState().publishing.all).toBeNull();
    expect(await store.getState().confirmPublishAll()).toBe(false);
    expect(sent()).toEqual([]);
  });

  it('is refused while the tab switches org, reading nothing', async () => {
    drafts([spot('spt_a', 3)]);
    vi.mocked(getSpots).mockClear();
    const store = sidebarStore('org_2');
    await store.getState().askPublishAll(ORG);
    expect(store.getState().publishing.all).toBeNull();
    expect(vi.mocked(getSpots)).not.toHaveBeenCalled();
  });

  it('is refused while the tab makes a new org, reading nothing', async () => {
    drafts([spot('spt_a', 3)]);
    vi.mocked(getSpots).mockClear();
    const store = sidebarStore(null, true);
    await store.getState().askPublishAll(ORG);
    expect(store.getState().publishing.all).toBeNull();
    expect(vi.mocked(getSpots)).not.toHaveBeenCalled();
  });

  it('offers no publish for more than one publish takes', async () => {
    drafts(Array.from({ length: 501 }, (_, i) => spot(`spt_${i}`, 1)));
    const store = sidebarStore();
    await store.getState().askPublishAll(ORG);
    expect(store.getState().publishing.all).toMatchObject({ tooMany: true });
    expect(await store.getState().confirmPublishAll()).toBe(false);
    expect(sent()).toEqual([]);
  });

  it('says what it does with no default playlist, as the server decides: it makes the first default, or no screen changes', async () => {
    const lunch = { id: 'pls_main', name: 'Lunch', isDefault: false, draftChanged: false };
    drafts([], [lunch], [{ ...entry('sch_1', false), target: 'group', groupId: 'grp_1' }]);
    const store = sidebarStore();
    await store.getState().askPublishAll(ORG);
    // No entry on every screen at all hours: the server compiles no screen without a default.
    expect(store.getState().publishing.all?.noDefault).toEqual({ makes: null });
    drafts([], [lunch], [entry('sch_2', false)]);
    await store.getState().askPublishAll(ORG);
    expect(store.getState().publishing.all?.noDefault).toEqual({ makes: 'Lunch' });
    // Every day spelled out, seven distinct days, is every day, as the server reads it; six is not.
    drafts([], [lunch], [{ ...entry('sch_3', false), days: [0, 1, 2, 3, 4, 5, 6] }]);
    await store.getState().askPublishAll(ORG);
    expect(store.getState().publishing.all?.noDefault).toEqual({ makes: 'Lunch' });
    drafts([], [lunch], [{ ...entry('sch_4', false), days: [1, 2, 3, 4, 5, 6] }]);
    await store.getState().askPublishAll(ORG);
    expect(store.getState().publishing.all?.noDefault).toEqual({ makes: null });
    drafts([], [{ ...lunch, isDefault: true }], [entry('sch_2', false)]);
    await store.getState().askPublishAll(ORG);
    expect(store.getState().publishing.all?.noDefault).toBeNull();
  });

  it('finds nothing to publish: says so, counts again, and never sends an empty publish', async () => {
    drafts([spot('spt_a', 3, { draftChanged: false })]);
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const store = createStore<PublishingSlice & { orgs: Orgs }>()((set, get) => ({
      ...createPublishingSlice(set as never, get as never, { router: ORG_ROUTER, queryClient } as never),
      orgs: { switchingTo: null, drafts: {} },
    }));
    await store.getState().askPublishAll(ORG);
    expect(store.getState().publishing.all).toMatchObject({ pins: [] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['org', ORG, 'overview'] });
    expect(await store.getState().confirmPublishAll()).toBe(false);
    expect(sent()).toEqual([]);
  });

  it('shows what it would change on screens, read beside the drafts, and with no draft but screens moving, publishes none to send them (#187)', async () => {
    const moved = {
      screens: [{ screenId: 'scr_1', name: 'Till', reasons: ['joined North'] }],
      unchanged: 2,
      failed: [],
      groups: [{ groupId: 'grp_n', name: 'North', joined: ['scr_1'], left: [] }],
      samples: [],
    };
    preview = moved;
    drafts([spot('spt_a', 3, { draftChanged: false })]);
    const store = sidebarStore();
    await store.getState().askPublishAll(ORG);
    expect(store.getState().publishing.all).toMatchObject({ pins: [], preview: moved });
    expect(await store.getState().confirmPublishAll()).toBe(true);
    expect(sent()).toEqual([['publish', { drafts: [] }, ORG]]);
  });

  it('refused for sample text, asks as every publish does, and Publish anyway sends the same pins acknowledging exactly what it showed (#360)', async () => {
    drafts([spot('spt_a', 3)]);
    const store = sidebarStore();
    await store.getState().askPublishAll(ORG);
    vi.mocked(callTool)
      .mockReset()
      .mockRejectedValueOnce(new Refusal('sample_text', 'sample', { spots: [{ id: 'spt_a', name: 'Pier 9', version: 3, fields: ['headline'] }] }))
      .mockImplementation(async () => published(++revision) as never);
    const done = store.getState().confirmPublishAll();
    await vi.waitFor(() => expect(store.getState().publishing.sampleCheck).not.toBeNull());
    store.getState().publishAnyway();
    expect(await done).toBe(true);
    expect(vi.mocked(callTool)).toHaveBeenLastCalledWith(
      'publish',
      {
        drafts: [{ kind: 'spot', id: 'spt_a', version: 3 }],
        allowSample: [{ spotId: 'spt_a', version: 3, fields: ['headline'] }],
      },
      ORG,
    );
  });
});
