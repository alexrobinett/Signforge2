// The playlist editor's store slice: each save belongs to the playlist it was made for, a draft
// waiting to be saved is saved before another playlist is opened, and Undo puts a removed spot
// back where it was. Tool calls go through a stubbed `fetch`, held open until the test answers.
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { PlaylistView } from '../src/lib/playlists';
import { playlistKeys } from '../src/queries/playlists';
import { createPlaylistEditorSlice, type PlaylistEditorSlice } from '../src/state/playlist-editor';

// The tab's org comes from the page's router, which a store test has none of.
vi.mock('~/lib/tab-org', () => ({ tabOrgHeaders: async () => ({}) }));
vi.mock('~/server/playlists.functions', () => ({ getPlaylists: vi.fn(), getPlaylist: vi.fn() }));
vi.mock('~/server/spots.functions', () => ({ getBrandKits: vi.fn(), getSpot: vi.fn(), getSpotPreview: vi.fn(), getSpots: vi.fn(), getTemplates: vi.fn() }));
vi.mock('~/server/assets.functions', () => ({ getAssets: vi.fn() }));
const toasts: { message: string; undo: () => void }[] = [];
vi.mock('sonner', () => ({
  toast: (message: string, opts: { action: { onClick: () => void } }) => toasts.push({ message, undo: opts.action.onClick }),
}));

const ORG = 'org_1';
const playlist = (id: string, version: number, spotIds: string[]): PlaylistView => ({
  id,
  name: id,
  transition: { type: 'cut' },
  spotIds,
  version,
  isDefault: false,
  published: false,
  draftChanged: true,
  publishedAt: null,
  createdAt: 0,
  updatedAt: 0,
});

/** Each tool call, held open: `answer` resolves it with the tool's output (or a refusal and its status). */
interface Call {
  name: string;
  input: Record<string, unknown>;
  answer: (body: unknown, status?: number) => void;
}
let calls: Call[] = [];

/** The org the tab's shell shows; a test switches it. */
const org = { id: ORG };

function setup() {
  const queryClient = new QueryClient();
  const router = {
    navigate: vi.fn(async ({ to }: { to: string }) => void (router.state.location.pathname = to)),
    state: {
      location: { pathname: '/spots' },
      get matches() {
        return [{ routeId: '/_app', loaderData: { organization: { id: org.id } } }];
      },
    },
  };
  const store = createStore<PlaylistEditorSlice & { redrawStage: () => void }>()((set, get) => ({
    ...createPlaylistEditorSlice(set as never, get as never, { router, queryClient } as never),
    redrawStage: () => {},
  }));
  const open = (p: PlaylistView) => queryClient.setQueryData(playlistKeys.one(ORG, p.id), p);
  return { store, router, queryClient, open, editor: () => store.getState().playlistEditor };
}

/** Let the store's awaits run. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  org.id = ORG;
  toasts.length = 0;
  vi.stubGlobal('fetch', (url: string, init: { body: string }) => {
    return new Promise<Response>((resolve) =>
      calls.push({
        name: url.split('/').at(-1) ?? '',
        input: JSON.parse(init.body),
        answer: (body, status = 200) => resolve(new Response(JSON.stringify(body), { status })),
      }),
    );
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('saves belong to the playlist they were made for (review 2)', () => {
  it("does not apply A's answer to B, opened while A's save was in flight", async () => {
    const { store, open, editor } = setup();
    const a = playlist('pls_a', 4, ['s1']);
    const b = playlist('pls_b', 1, ['s1']);
    open(a);
    open(b);
    store.getState().editPlaylist(ORG, a.id, (d) => ({ ...d, spotIds: [] }));
    void store.getState().savePlaylistDraft('pls_a');
    await settle();
    expect(calls).toMatchObject([{ name: 'update_playlist', input: { playlistId: 'pls_a', ifVersion: 4 } }]);

    store.getState().editPlaylist(ORG, b.id, (d) => ({ ...d, name: 'B, renamed' }));
    calls[0]!.answer({ playlist: playlist('pls_a', 5, []) });
    await settle();
    expect(editor().playlistId).toBe('pls_b');
    expect(editor().drafts.pls_b).toMatchObject({ version: 1, status: 'unsaved', error: null, stale: false });

    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.at(-1)).toMatchObject({ name: 'update_playlist', input: { playlistId: 'pls_b', name: 'B, renamed', ifVersion: 1 } });
  });

  it("saves A's waiting edit when B is opened, at the version A's save in flight returns", async () => {
    const { store, open, queryClient } = setup();
    const a = playlist('pls_a', 4, ['s1', 's2']);
    const b = playlist('pls_b', 1, ['s1']);
    open(a);
    open(b);
    store.getState().editPlaylist(ORG, a.id, (d) => ({ ...d, spotIds: ['s2', 's1'] }));
    void store.getState().savePlaylistDraft('pls_a');
    await settle();
    // A second edit of A, still waiting out its second when B gets its first edit.
    store.getState().editPlaylist(ORG, a.id, (d) => ({ ...d, spotIds: ['s2'] }));
    store.getState().editPlaylist(ORG, b.id, (d) => ({ ...d, name: 'B, renamed' }));
    calls[0]!.answer({ playlist: playlist('pls_a', 5, ['s2', 's1']) });
    await settle();

    expect(calls[1]).toMatchObject({ name: 'update_playlist', input: { playlistId: 'pls_a', spotIds: ['s2'], ifVersion: 5 } });
    calls[1]!.answer({ playlist: playlist('pls_a', 6, ['s2']) });
    await settle();
    expect(queryClient.getQueryData(playlistKeys.one(ORG, 'pls_a'))).toMatchObject({ version: 6, spotIds: ['s2'] });
  });

  it('does not write a playlist deleted meanwhile back into the cache', async () => {
    const { store, open, queryClient } = setup();
    const a = playlist('pls_a', 4, ['s1']);
    open(a);
    store.getState().editPlaylist(ORG, a.id, (d) => ({ ...d, spotIds: [] }));
    void store.getState().savePlaylistDraft('pls_a');
    await settle();
    void store.getState().deletePlaylist(ORG, 'pls_a');
    await settle();
    calls[1]!.answer({ deleted: 'pls_a' });
    await settle();
    calls[0]!.answer({ playlist: playlist('pls_a', 5, []) });
    await settle();
    expect(queryClient.getQueryData(playlistKeys.one(ORG, 'pls_a'))).toBeUndefined();
  });

  it('keeps the waiting save when a delete is refused', async () => {
    const { store, open, editor } = setup();
    const a = playlist('pls_a', 4, ['s1']);
    open(a);
    store.getState().editPlaylist(ORG, a.id, (d) => ({ ...d, name: 'Renamed' }));
    void store.getState().deletePlaylist(ORG, 'pls_a');
    await settle();
    calls[0]!.answer({ error: 'conflict', message: 'playlist pls_a is the default playlist' }, 409);
    await settle();
    expect(editor().deleting.error).toBe('playlist pls_a is the default playlist');
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.at(-1)).toMatchObject({ name: 'update_playlist', input: { playlistId: 'pls_a', name: 'Renamed' } });
  });

  it('says so, and stops saving, when someone else deleted the playlist', async () => {
    const { store, open, editor } = setup();
    const a = playlist('pls_a', 4, ['s1']);
    open(a);
    store.getState().editPlaylist(ORG, a.id, (d) => ({ ...d, name: 'Renamed' }));
    void store.getState().savePlaylistDraft('pls_a');
    await settle();
    calls[0]!.answer({ error: 'not_found', message: 'playlist pls_a not found' }, 404);
    await settle();
    expect(editor().drafts.pls_a).toMatchObject({ gone: true });
    store.getState().editPlaylist(ORG, a.id, (d) => ({ ...d, name: 'Again' }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(1);
  });
});

describe('a save answered after an org switch (versioned draft)', () => {
  it('changes nothing: the draft is not marked saved, and its version stays', async () => {
    const { store, open, editor } = setup();
    const a = playlist('pls_a', 4, ['s1']);
    open(a);
    store.getState().editPlaylist(ORG, a.id, (d) => ({ ...d, name: 'Renamed' }));
    void store.getState().savePlaylistDraft('pls_a');
    await settle();
    org.id = 'org_2';
    calls[0]!.answer({ playlist: { ...a, name: 'Renamed', version: 5 } });
    await settle();
    expect(editor().drafts.pls_a).toMatchObject({ status: 'unsaved', version: 4, savedAt: null });
  });
});

describe('Undo of a removed spot (review 2 and 3)', () => {
  it('puts the spot back at its place in the order as it is now, keeping what was done since', async () => {
    const { store, open, editor } = setup();
    const a = playlist('pls_a', 1, ['opening', 'lunch', 'closing']);
    open(a);
    store.getState().removeSpotFromPlaylist(ORG, a.id, 1, 'Lunch');
    store.getState().addSpotToPlaylist(ORG, a.id, 'extra');
    toasts[0]!.undo();
    expect(editor().drafts.pls_a?.edit.spotIds).toEqual(['opening', 'lunch', 'closing', 'extra']);

    // Removed from the end, then the list shrank: it goes back at the end.
    store.getState().removeSpotFromPlaylist(ORG, a.id, 3, 'Extra');
    store.getState().removeSpotFromPlaylist(ORG, a.id, 2, 'Closing');
    toasts[1]!.undo();
    expect(editor().drafts.pls_a?.edit.spotIds).toEqual(['opening', 'lunch', 'extra']);
  });

  it('does nothing once another playlist is being edited', () => {
    const { store, open, editor } = setup();
    const a = playlist('pls_a', 1, ['s1', 's2']);
    const b = playlist('pls_b', 1, ['s3']);
    open(a);
    open(b);
    store.getState().removeSpotFromPlaylist(ORG, a.id, 0, 'S1');
    store.getState().editPlaylist(ORG, b.id, (d) => ({ ...d, spotIds: [] }));
    toasts[0]!.undo();
    expect(editor().playlistId).toBe('pls_b');
    expect(editor().drafts.pls_b?.edit.spotIds).toEqual([]);
    expect(editor().drafts.pls_a?.edit.spotIds).toEqual(['s2']);
  });
});

describe('Undo pressed after the removal autosaved (re-check of #153, 2)', () => {
  it('puts the spot back once, on the version the removal saved', async () => {
    const { store, open, editor, queryClient } = setup();
    const a = playlist('pls_a', 1, ['opening', 'lunch', 'closing']);
    open(a);
    store.getState().removeSpotFromPlaylist(ORG, a.id, 1, 'Lunch');
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.at(-1)).toMatchObject({ name: 'update_playlist', input: { spotIds: ['opening', 'closing'], ifVersion: 1 } });
    calls.at(-1)!.answer({ playlist: playlist('pls_a', 2, ['opening', 'closing']) });
    await settle();
    expect(queryClient.getQueryData(playlistKeys.one(ORG, 'pls_a'))).toMatchObject({ version: 2 });

    toasts[0]!.undo();
    expect(editor().drafts.pls_a?.edit.spotIds).toEqual(['opening', 'lunch', 'closing']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.at(-1)).toMatchObject({ name: 'update_playlist', input: { spotIds: ['opening', 'lunch', 'closing'], ifVersion: 2 } });
  });
});

describe('New playlist from elsewhere (#367, review of #458)', () => {
  it('goes to Playlists, and asks for its dialog only when the org has a spot to put in one', async () => {
    const { getSpots } = await import('../src/server/spots.functions');
    const { store } = setup();
    vi.mocked(getSpots).mockResolvedValueOnce({ spots: [] } as never);
    await store.getState().startNewPlaylist(ORG);
    // No spot: nothing left asked for, to open on a later visit.
    expect(store.getState().playlistEditor.newPlaylist.open).toBe(false);
    vi.mocked(getSpots).mockResolvedValueOnce({ spots: [{ id: 'spt_1' }] } as never);
    const { store: withSpot } = setup();
    await withSpot.getState().startNewPlaylist(ORG);
    expect(withSpot.getState().playlistEditor.newPlaylist.open).toBe(true);
  });

  it('asks for nothing when the member went elsewhere before its read came back (review of #458)', async () => {
    const { getSpots } = await import('../src/server/spots.functions');
    let answer: (v: unknown) => void = () => {};
    vi.mocked(getSpots).mockImplementationOnce(() => new Promise((r) => (answer = r)) as never);
    const { store, router } = setup();
    const starting = store.getState().startNewPlaylist(ORG);
    await settle();
    // Gone elsewhere (a sidebar link) while Playlists' read is on its way.
    router.state.location.pathname = '/spots';
    answer({ spots: [{ id: 'spt_1' }] });
    await starting;
    expect(store.getState().playlistEditor.newPlaylist.open).toBe(false);
  });
});
