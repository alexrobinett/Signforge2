// The playlist editor's store slice: Undo puts a removed spot back where it was. Tool calls go
// through a stubbed `fetch`, held open until the test answers.
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { PlaylistView } from '../src/lib/playlists';
import { playlistKeys } from '../src/queries/playlists';
import { createPlaylistEditorSlice, type PlaylistEditorSlice } from '../src/state/playlist-editor';

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

function setup() {
  const queryClient = new QueryClient();
  const router = { navigate: vi.fn(async () => {}) };
  const store = createStore<PlaylistEditorSlice & { redrawStage: () => void }>()((set, get) => ({
    ...createPlaylistEditorSlice(set as never, get as never, { router, queryClient } as never),
    redrawStage: () => {},
  }));
  const open = (p: PlaylistView) => queryClient.setQueryData(playlistKeys.one(ORG, p.id), p);
  return { store, queryClient, open, editor: () => store.getState().playlistEditor };
}

/** Let the store's awaits run. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
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

describe('Undo of a removed spot (review 3)', () => {
  it('puts the spot back at its place in the order as it is now, keeping what was done since', async () => {
    const { store, open, editor } = setup();
    const a = playlist('pls_a', 1, ['opening', 'lunch', 'closing']);
    open(a);
    store.getState().removeSpotFromPlaylist(ORG, a, 1, 'Lunch');
    store.getState().addSpotToPlaylist(ORG, a, 'extra');
    toasts[0]!.undo();
    expect(editor().draft?.spotIds).toEqual(['opening', 'lunch', 'closing', 'extra']);

    // Removed from the end, then the list shrank: it goes back at the end.
    store.getState().removeSpotFromPlaylist(ORG, a, 3, 'Extra');
    store.getState().removeSpotFromPlaylist(ORG, a, 2, 'Closing');
    toasts[1]!.undo();
    expect(editor().draft?.spotIds).toEqual(['opening', 'lunch', 'extra']);
  });
});
