// The drawer's drafts in the store (#268): nothing written until the person saves them, nor before
// every draft has its summary; a save as the API answers it, a refused one overwriting nothing; Undo
// putting each back as it was, as the person, the last first, at the version its target is at now,
// and carrying on from where one that failed stopped. The API, the pages' reads and the tools are
// stubs; nothing waits on a clock.
import { type AnswerCard, CHAT_EVENTS } from '@signforge/api/agent-chat';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { type AgentDrawerSlice, createAgentDrawerSlice } from '../src/state/agent-drawer';

vi.mock('~/lib/tab-org', () => ({ tabOrgHeaders: async () => ({}) }));
vi.mock('~/lib/live', () => ({ orgOnScreen: () => 'org_1' }));
// The pages' reads, for the summaries: an empty org whose card template has a headline; each read
// fails while `fail`, and the templates are read without the card's version while `stale` is above 0.
const reads = vi.hoisted(() => ({ fail: false, stale: 0, templatesRead: 0, hold: undefined as Promise<void> | undefined }));
const CARD_VERSION = { id: 'tpv_card', manifest: { fields: { headline: { type: 'text', label: 'Headline' } } } };
const read = (key: string, data: () => unknown) => ({
  queryKey: ['org', 'org_1', key],
  queryFn: async () => {
    await reads.hold;
    return reads.fail ? Promise.reject(new Error('offline')) : data();
  },
});
vi.mock('~/queries/screens', () => ({ screensQuery: () => read('screens', () => ({ screens: [], groups: [] })) }));
vi.mock('~/queries/schedule', () => ({ scheduleQuery: () => read('schedule', () => ({ entries: [] })) }));
vi.mock('~/queries/playlists', () => ({ playlistsQuery: () => read('playlists', () => ({ playlists: [] })) }));
vi.mock('~/queries/spots', () => ({
  spotsQuery: () => read('spots', () => ({ spots: [] })),
  templatesQuery: () =>
    read('templates', () => {
      reads.templatesRead++;
      return { templates: [{ versions: reads.stale-- > 0 ? [] : [CARD_VERSION] }] };
    }),
}));
// The tools Undo calls: each answers with `answer`, or throws while `failing` names it.
const tools = vi.hoisted(() => ({
  calls: [] as { name: string; input: unknown }[],
  failing: new Set<string>(),
  answer: (_name: string, _input: any): unknown => ({}),
}));
vi.mock('~/lib/tools', async (actual) => ({
  ...(await actual<object>()),
  callToolByName: async (name: string, input: unknown) => {
    tools.calls.push({ name, input });
    if (tools.failing.has(name)) throw new Error(`${name} failed`);
    return tools.answer(name, input);
  },
}));

const sent: { path: string; body: any }[] = [];
/** The API's answers, in order: a turn's events are made for its request, which names its run. */
const answers: (Response | ((body: any) => Response))[] = [];
beforeEach(() => {
  sent.length = 0;
  answers.length = 0;
  tools.calls.length = 0;
  tools.failing.clear();
  tools.answer = () => ({});
  Object.assign(reads, { fail: false, stale: 0, templatesRead: 0, hold: undefined });
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    sent.push({ path, body: JSON.parse(String(init.body)) });
    const res = answers.shift();
    if (!res) throw new Error(`no answer for ${path}`);
    return typeof res === 'function' ? res(sent.at(-1)?.body) : res;
  });
});
afterEach(() => vi.unstubAllGlobals());

const BEFORE = { id: 'spt_1', name: 'Promo', templateVersionId: 'tpv_card', data: { headline: 'Breakfast served' }, version: 3 };
const CARD: AnswerCard = {
  text: 'A punchier headline, and breakfast on the drive-thrus.',
  groups: [],
  steps: [],
  trace: [],
  drafts: [
    {
      tool: 'update_spot',
      input: { spotId: 'spt_1', data: { headline: 'Hot breakfast, fast' }, ifVersion: 3 },
      target: { kind: 'spot', id: 'spt_1' },
      before: BEFORE,
    },
    { tool: 'create_schedule_entry', input: { playlistId: 'pls_b', target: 'group', groupId: 'grp_dt', idempotencyKey: 'k' }, target: null, before: null },
  ],
};
/** A turn answered with `card`, as the API streams it (#350): the run, the card, its end. */
const turn =
  (card: AnswerCard = CARD) =>
  ({ runId, threadId }: { runId: string; threadId: string }) =>
    new Response(
      [{ type: 'RUN_STARTED' }, { type: 'CUSTOM', name: CHAT_EVENTS.answer, value: card }, { type: 'RUN_FINISHED', finishReason: 'stop' }]
        .map((e) => `data: ${JSON.stringify({ runId, threadId, timestamp: 1, ...e })}\n\n`)
        .join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    );

/** `published`: what each publish the drawer asks for answers; with it, the page shows an org, so Publish now runs. */
function draftsStore(published?: boolean) {
  const reloaded: string[] = [];
  const matches = published === undefined ? [] : [{ routeId: '/_app', loaderData: { organization: { id: 'org_1' } } }];
  const store = createStore<any>()((set, get) => ({
    ...createAgentDrawerSlice(set, get, {
      router: { state: { location: { pathname: '/spots/spt_1' }, matches } },
      queryClient: new QueryClient(),
    } as never),
    agent: { filled: {} },
    setRightPanel: () => {},
    reloadSpot: async (_o: string, id: string) => void reloaded.push(id),
    publishSpot: vi.fn(async () => published ?? true),
    publishEntry: vi.fn(async () => published ?? true),
    publishPlaylist: vi.fn(async () => published ?? true),
  }));
  const at = () => store.getState().agentDrawer.messages[1];
  return { store: store as unknown as { getState: () => AgentDrawerSlice & Record<string, any> }, reloaded, at };
}

describe("the drawer's drafts, in the store", () => {
  /** The save's answer: both drafts written. */
  const savedBoth = () =>
    Response.json({
      results: [
        { tool: 'update_spot', ok: true, output: { spot: { ...BEFORE, data: { headline: 'Hot breakfast, fast' }, version: 4 } } },
        { tool: 'create_schedule_entry', ok: true, output: { entry: { id: 'sch_new', version: 1 } } },
      ],
    });
  /** The drafts proposed, saved and Publish now pressed, each publish answering `published`. */
  async function publishedNow(published: boolean) {
    const made = draftsStore(published);
    answers.push(turn());
    await made.store.getState().askAgent('Make the headline punchier');
    answers.push(savedBoth());
    await made.store.getState().saveDrafts(1);
    await made.store.getState().publishDrafts(1);
    return made;
  }

  it('says Publish now was not published when a publish was let go, such as Edit first on sample text (#360), and stops there', async () => {
    const { store, at } = await publishedNow(false);
    expect(store.getState().publishSpot).toHaveBeenCalledWith('org_1', 'spt_1');
    expect(store.getState().publishEntry).not.toHaveBeenCalled();
    expect(at().drafts).toMatchObject({ status: 'saved', error: 'Not published: the changes are saved as drafts.' });
  });

  it('says published once every publish went through', async () => {
    const { store, at } = await publishedNow(true);
    expect(store.getState().publishEntry).toHaveBeenCalledWith('org_1', 'sch_new');
    expect(at().drafts).toMatchObject({ status: 'published', error: null });
  });

  it("leaves the next org's turn be when the last org's drafts are still being worked out as the drawer is forgotten (review of #402)", async () => {
    const { store } = draftsStore();
    // The first turn's summary waits on the pages' reads.
    let release: () => void = () => {};
    reads.hold = new Promise((r) => {
      release = r;
    });
    answers.push(turn());
    const first = store.getState().askAgent('Make the headline punchier');
    await vi.waitFor(() => expect(store.getState().agentDrawer.messages[1]).toMatchObject({ drafts: { shown: { state: 'working' } } }));
    store.getState().forgetAgentDrawer();
    // The next org's turn, which answers only once the first has finished.
    let answer: () => void = () => {};
    const gate = new Promise<void>((r) => {
      answer = r;
    });
    answers.push((body) => {
      const res = turn({ ...CARD, drafts: [] })(body);
      return new Response(
        new ReadableStream({
          async start(c) {
            await gate;
            c.enqueue(new Uint8Array(await res.arrayBuffer()));
            c.close();
          },
        }),
        { headers: res.headers },
      );
    });
    const second = store.getState().askAgent('What plays?');
    reads.hold = undefined;
    release();
    await first;
    answer();
    await second;
    expect(store.getState().agentDrawer).toMatchObject({
      asking: false,
      messages: [
        { role: 'user', text: 'What plays?' },
        { role: 'assistant', card: { text: CARD.text }, drafts: null },
      ],
    });
  });

  it('writes nothing until saved; a save marks the spot in its editor and reloads it; Undo puts each back, the last first', async () => {
    const { store, reloaded, at } = draftsStore();
    answers.push(turn());
    await store.getState().askAgent('Make the headline punchier, and breakfast weekdays 6-11 on the drive-thrus');
    expect(at()).toMatchObject({ role: 'assistant', drafts: { status: 'proposed', shown: { state: 'shown' } } });
    expect(at().drafts.shown.summaries).toHaveLength(2);
    expect(sent.map((s) => s.path)).toEqual(['/api/agent/chat']);

    answers.push(savedBoth());
    await store.getState().saveDrafts(1);
    expect(sent.at(-1)).toEqual({ path: '/api/agent/apply', body: { calls: CARD.drafts.map(({ tool, input }) => ({ tool, input })) } });
    expect(at().drafts).toMatchObject({ status: 'saved', error: null });
    expect(reloaded).toEqual(['spt_1']);
    expect(store.getState().agent.filled.spt_1).toMatchObject({
      kind: 'update',
      before: { headline: 'Breakfast served' },
      wrote: { headline: 'Hot breakfast, fast' },
    });

    await store.getState().undoDrafts(1);
    expect(tools.calls).toEqual([
      { name: 'delete_schedule_entry', input: { scheduleEntryId: 'sch_new', ifVersion: 1 } },
      { name: 'update_spot', input: { spotId: 'spt_1', data: { headline: 'Breakfast served' }, ifVersion: 4 } },
    ]);
    expect(at().drafts.status).toBe('undone');
    expect(store.getState().agent.filled.spt_1).toBeUndefined();
  });

  it('shows a refused save as the refused call, overwriting nothing: someone saved the spot since', async () => {
    const { store, at } = draftsStore();
    answers.push(turn());
    await store.getState().askAgent('Punchier');
    answers.push(
      Response.json({ results: [{ tool: 'update_spot', ok: false, error: 'conflict', message: 'spot spt_1 changed since version 3' }] }, { status: 409 }),
    );
    await store.getState().saveDrafts(1);
    expect(at().drafts).toMatchObject({ status: 'refused', error: 'spot spt_1 changed since version 3' });
    expect(store.getState().agent.filled).toEqual({});
    // Nothing of it was written, so Undo puts nothing back.
    await store.getState().undoDrafts(1);
    expect(tools.calls).toEqual([]);
  });
  it('keeps Save from writing until every draft has its summary; a read that fails says so, and Try again works it out', async () => {
    const { store, at } = draftsStore();
    reads.fail = true;
    answers.push(turn());
    await store.getState().askAgent('Punchier');
    expect(at().drafts.shown).toEqual({ state: 'failed', reason: expect.stringMatching(/Could not read/) });
    await store.getState().saveDrafts(1);
    expect(sent.map((s) => s.path)).toEqual(['/api/agent/chat']);
    expect(at().drafts.status).toBe('proposed');

    reads.fail = false;
    await store.getState().showDrafts(1);
    expect(at().drafts.shown).toMatchObject({ state: 'shown', summaries: [{ title: 'Spot Promo' }, { title: 'New schedule entry' }] });
    answers.push(Response.json({ results: [] }));
    await store.getState().saveDrafts(1);
    expect(sent.map((s) => s.path)).toEqual(['/api/agent/chat', '/api/agent/apply']);
  });

  it('reads the templates again for a spot on a version they did not have, and refuses to save while it is still not read', async () => {
    const { store, at } = draftsStore();
    reads.stale = 1;
    answers.push(turn());
    await store.getState().askAgent('Punchier');
    expect(reads.templatesRead).toBe(2);
    expect(at().drafts.shown.state).toBe('shown');

    const second = draftsStore();
    reads.stale = 2;
    answers.push(turn());
    await second.store.getState().askAgent('Punchier');
    expect(second.at().drafts.shown).toEqual({ state: 'failed', reason: expect.stringMatching(/template could not be read/) });
    await second.store.getState().saveDrafts(1);
    expect(sent.filter((s) => s.path === '/api/agent/apply')).toEqual([]);
  });

  /** An answer of `drafts`, saved as the API answers them with `results`. */
  async function saved(drafts: AnswerCard['drafts'], results: unknown[]) {
    const s = draftsStore();
    answers.push(turn({ ...CARD, drafts }));
    await s.store.getState().askAgent('Change it');
    answers.push(Response.json({ results }));
    await s.store.getState().saveDrafts(1);
    expect(s.at().drafts.status).toBe('saved');
    return s;
  }
  const ENTRY = {
    id: 'sch_1',
    playlistId: 'pls_a',
    target: 'org',
    groupId: null,
    screenId: null,
    priority: 2,
    days: [1, 2],
    from: '06:00',
    to: null,
    startDate: null,
    endDate: null,
    version: 4,
  };

  it("puts a schedule entry's aim back whole: from a group to everywhere, and from everywhere to a group", async () => {
    const toGroup = await saved(
      [
        {
          tool: 'update_schedule_entry',
          input: { scheduleEntryId: 'sch_1', target: 'group', groupId: 'grp_dt', ifVersion: 4 },
          target: { kind: 'schedule_entry', id: 'sch_1' },
          before: ENTRY,
        },
      ],
      [{ tool: 'update_schedule_entry', ok: true, output: { entry: { ...ENTRY, target: 'group', groupId: 'grp_dt', version: 5 } } }],
    );
    await toGroup.store.getState().undoDrafts(1);
    expect(tools.calls).toEqual([
      {
        name: 'update_schedule_entry',
        input: {
          scheduleEntryId: 'sch_1',
          playlistId: 'pls_a',
          target: 'org',
          priority: 2,
          days: [1, 2],
          from: '06:00',
          to: null,
          startDate: null,
          endDate: null,
          ifVersion: 5,
        },
      },
    ]);

    tools.calls.length = 0;
    const grouped = { ...ENTRY, target: 'group', groupId: 'grp_dt' };
    const toOrg = await saved(
      [
        {
          tool: 'update_schedule_entry',
          input: { scheduleEntryId: 'sch_1', target: 'org', ifVersion: 4 },
          target: { kind: 'schedule_entry', id: 'sch_1' },
          before: grouped,
        },
      ],
      [{ tool: 'update_schedule_entry', ok: true, output: { entry: { ...ENTRY, version: 5 } } }],
    );
    await toOrg.store.getState().undoDrafts(1);
    expect(tools.calls).toEqual([
      {
        name: 'update_schedule_entry',
        input: {
          scheduleEntryId: 'sch_1',
          playlistId: 'pls_a',
          target: 'group',
          groupId: 'grp_dt',
          priority: 2,
          days: [1, 2],
          from: '06:00',
          to: null,
          startDate: null,
          endDate: null,
          ifVersion: 5,
        },
      },
    ]);
  });

  it('carries on an Undo that stopped from where it did, each draft at the version its target is at now: two playlist changes and an entry made', async () => {
    const PLAYLIST = { id: 'pls_a', name: 'Breakfast', transition: { type: 'cut' }, spotIds: ['spt_1'], version: 5 };
    const drafts: AnswerCard['drafts'] = [
      { tool: 'update_playlist', input: { playlistId: 'pls_a', name: 'Morning', ifVersion: 5 }, target: { kind: 'playlist', id: 'pls_a' }, before: PLAYLIST },
      {
        tool: 'update_playlist',
        input: { playlistId: 'pls_a', spotIds: [], ifVersion: 6 },
        target: { kind: 'playlist', id: 'pls_a' },
        before: { ...PLAYLIST, name: 'Morning', version: 6 },
      },
      { tool: 'create_schedule_entry', input: { playlistId: 'pls_a', target: 'org', idempotencyKey: 'k' }, target: null, before: null },
    ];
    const { store, at } = await saved(drafts, [
      { tool: 'update_playlist', ok: true, output: { playlist: { ...PLAYLIST, name: 'Morning', version: 6 } } },
      { tool: 'update_playlist', ok: true, output: { playlist: { ...PLAYLIST, name: 'Morning', spotIds: [], version: 7 } } },
      { tool: 'create_schedule_entry', ok: true, output: { entry: { ...ENTRY, id: 'sch_new', version: 1 } } },
    ]);
    // Each undo answers with the version it left.
    let version = 7;
    tools.answer = (name) => (name === 'update_playlist' ? { playlist: { ...PLAYLIST, version: ++version } } : { deleted: 'sch_new', version: null });
    tools.failing.add('update_playlist');
    await store.getState().undoDrafts(1);
    expect(at().drafts).toMatchObject({ status: 'saved', error: 'update_playlist failed', undone: [2] });
    expect(tools.calls.map((c) => c.input)).toEqual([
      { scheduleEntryId: 'sch_new', ifVersion: 1 },
      { playlistId: 'pls_a', spotIds: ['spt_1'], ifVersion: 7 },
    ]);

    tools.calls.length = 0;
    tools.failing.clear();
    await store.getState().undoDrafts(1);
    expect(tools.calls.map((c) => c.input)).toEqual([
      { playlistId: 'pls_a', spotIds: ['spt_1'], ifVersion: 7 },
      // The first change, at the version the undo of the second left.
      { playlistId: 'pls_a', name: 'Breakfast', ifVersion: 8 },
    ]);
    expect(at().drafts).toMatchObject({ status: 'undone', error: null, undone: [2, 1, 0] });
  });
});
