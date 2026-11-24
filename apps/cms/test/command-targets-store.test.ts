// ⌘K's found screens and groups in the store (#180): what is typed, the actions shown, and an
// action run (a tool call, through a stubbed `fetch`, or a navigation). Nothing waits on a clock.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { CommandEntry, TargetAction } from '../src/lib/command-menu';
import { createCommandMenuSlice, type CommandMenuSlice } from '../src/state/command-menu';
import { toast } from 'sonner';

vi.mock('~/lib/tab-org', () => ({ tabOrgHeaders: async () => ({}) }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

let calls: { name: string; input: unknown }[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };

function menuStore() {
  const router = { navigate: vi.fn(async () => {}), invalidate: vi.fn(async () => {}) };
  const store = createStore<CommandMenuSlice & { ui: object }>()((set, get) => ({
    ui: {},
    ...createCommandMenuSlice(set as never, get as never, { router } as never),
  }));
  return { store, router };
}

beforeEach(() => {
  calls = [];
  reply = { status: 200, body: {} };
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    calls.push({ name: url.split('/').at(-1) ?? '', input: JSON.parse(init.body) });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
});

const identify: TargetAction = {
  kind: 'tool',
  label: 'Identify (10 s)',
  tool: 'identify_screen',
  screenId: 'scr_1',
  screenName: '0157 Drive-thru L',
  done: 'Sent.',
};

/** Holds the next tool call: resolves once it is sent, and answers it when told to. */
function holdNextCall() {
  let answer!: (status: number) => void;
  const sent = new Promise<void>((resolve) => {
    vi.stubGlobal('fetch', (url: string, init: { body: string }) => {
      calls.push({ name: url.split('/').at(-1) ?? '', input: JSON.parse(init.body) });
      resolve();
      return new Promise<Response>((r) => {
        answer = (status) => r(new Response('{}', { status }));
      });
    });
  });
  return { sent, answer: (status: number) => answer(status) };
}

describe('a call on its way across closing and opening again', () => {
  const restart: TargetAction = { kind: 'tool', label: 'Restart player', tool: 'restart_screen', screenId: 'scr_1', screenName: 'Lobby', done: 'Sent.' };

  it('is not sent again from a later opening, and its answer leaves that opening open', async () => {
    const { store } = menuStore();
    const held = holdNextCall();
    store.getState().openCommandMenu();
    store.getState().chooseTarget({ kind: 'screen', id: 'scr_1' });
    const first = store.getState().runTargetAction(restart);
    await held.sent;
    store.getState().closeCommandMenu();
    store.getState().openCommandMenu();
    store.getState().chooseTarget({ kind: 'screen', id: 'scr_1' });
    expect(store.getState().commandMenu.running).toBe(true);
    await store.getState().runTargetAction(restart);
    expect(calls.map((c) => c.name)).toEqual(['restart_screen']);

    held.answer(200);
    await first;
    expect(store.getState().commandMenu).toMatchObject({ open: true, target: { kind: 'screen', id: 'scr_1' }, running: false });
    expect(toast.success).toHaveBeenCalledWith('Restart player: Lobby', { description: 'Sent.' });
  });

  it('closes the opening that sent it, once it works', async () => {
    const { store } = menuStore();
    const held = holdNextCall();
    store.getState().openCommandMenu();
    const call = store.getState().runTargetAction(restart);
    await held.sent;
    held.answer(200);
    await call;
    expect(store.getState().commandMenu).toMatchObject({ open: false, running: false });
  });

  it('holds a tool run from the list too: no second call while the first is on its way', async () => {
    const { store } = menuStore();
    const held = holdNextCall();
    const list = { name: 'list_screens', description: 'List the screens.', mutates: false, fields: [] };
    const entry: CommandEntry = { kind: 'tool', id: 'tool:list_screens', label: 'List the screens', tool: list, keywords: [] };
    store.getState().openCommandMenu();
    const first = store.getState().chooseCommand(entry);
    await held.sent;
    store.getState().closeCommandMenu();
    store.getState().openCommandMenu();
    await store.getState().chooseCommand(entry);
    expect(calls.map((c) => c.name)).toEqual(['list_screens']);
    held.answer(200);
    await first;
    expect(store.getState().commandMenu).toMatchObject({ open: true, running: false });
  });
});

describe("⌘K's selection and focus (#180)", () => {
  it('counts a move the member made until they type again, and opens with neither a move nor a way back', () => {
    const { store } = menuStore();
    store.getState().openCommandMenu();
    store.getState().searchCommands('deli');
    store.getState().moveCommandSelection();
    expect(store.getState().commandMenu.moved).toBe(true);
    store.getState().searchCommands('delic');
    expect(store.getState().commandMenu.moved).toBe(false);
    store.getState().chooseTarget({ kind: 'screen', id: 'scr_1' });
    store.getState().backToCommands();
    expect(store.getState().commandMenu.backed).toBe(true);
    store.getState().moveCommandSelection();
    store.getState().closeCommandMenu();
    store.getState().openCommandMenu();
    expect(store.getState().commandMenu).toMatchObject({ moved: false, backed: false });
  });
});

describe('⌘K on a found screen or group', () => {
  it('keeps what is typed through a target and Back, and starts empty when opened again', () => {
    const { store } = menuStore();
    store.getState().openCommandMenu();
    store.getState().searchCommands('0157');
    store.getState().chooseTarget({ kind: 'screen', id: 'scr_1' });
    expect(store.getState().commandMenu).toMatchObject({ query: '0157', target: { kind: 'screen', id: 'scr_1' } });
    store.getState().backToCommands();
    expect(store.getState().commandMenu).toMatchObject({ query: '0157', target: null });
    store.getState().closeCommandMenu();
    store.getState().openCommandMenu();
    expect(store.getState().commandMenu).toMatchObject({ open: true, query: '', target: null });
  });

  it("runs a screen's tool with its id, closes, and says so", async () => {
    const { store } = menuStore();
    store.getState().openCommandMenu();
    store.getState().chooseTarget({ kind: 'screen', id: 'scr_1' });
    await store.getState().runTargetAction(identify);
    expect(calls).toEqual([{ name: 'identify_screen', input: { screenId: 'scr_1' } }]);
    expect(store.getState().commandMenu).toMatchObject({ open: false, target: null, running: false });
    expect(toast.success).toHaveBeenCalledWith('Identify (10 s): 0157 Drive-thru L', { description: 'Sent.' });
  });

  it('stays open on the screen after a refusal, and says why', async () => {
    const { store } = menuStore();
    store.getState().openCommandMenu();
    store.getState().chooseTarget({ kind: 'screen', id: 'scr_1' });
    reply = { status: 403, body: { error: 'forbidden', message: 'Your role cannot do that.' } };
    await store.getState().runTargetAction(identify);
    expect(store.getState().commandMenu).toMatchObject({ open: true, target: { kind: 'screen', id: 'scr_1' }, running: false });
    expect(toast.error).toHaveBeenCalledWith('Identify (10 s): 0157 Drive-thru L', { description: 'Your role cannot do that.' });
  });

  it("opens a screen's page, and a group's screens on the Screens page, closing the menu", async () => {
    const { store, router } = menuStore();
    store.getState().openCommandMenu();
    await store.getState().runTargetAction({ kind: 'open-screen', label: 'Open', screenId: 'scr_1' });
    expect(router.navigate).toHaveBeenLastCalledWith({ to: '/screens/$screenId', params: { screenId: 'scr_1' } });
    expect(store.getState().commandMenu.open).toBe(false);
    store.getState().openCommandMenu();
    await store.getState().runTargetAction({ kind: 'open-group', label: 'Show its screens', groupId: 'grp_1' });
    expect(router.navigate).toHaveBeenLastCalledWith({ to: '/screens', search: { group: 'grp_1' } });
    expect(store.getState().commandMenu.open).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('a tool refused for sample text (#360)', () => {
  /** ⌘K on a page of org_1, with the question about sample text answering `yes`. */
  function sampleStore(yes: boolean) {
    const router = {
      navigate: vi.fn(async () => {}),
      invalidate: vi.fn(async () => {}),
      state: { matches: [{ routeId: '/_app', loaderData: { organization: { id: 'org_1' } } }] },
    };
    const askSampleText = vi.fn(async () => yes);
    const store = createStore<CommandMenuSlice & { ui: object; askSampleText: typeof askSampleText }>()((set, get) => ({
      ui: {},
      askSampleText,
      ...createCommandMenuSlice(set as never, get as never, { router } as never),
    }));
    return { store, askSampleText };
  }
  const spots = [{ id: 'spt_pier', name: 'Pier 9', fields: ['headline'] }];
  /** The first call refused for sample text, the next answered. */
  const refusedOnce = () => {
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      calls.push({ name: url.split('/').at(-1) ?? '', input: JSON.parse(init.body) });
      return calls.length === 1
        ? new Response(JSON.stringify({ error: 'sample_text', message: 'still holding sample text', details: { spots } }), { status: 409 })
        : new Response('{}', { status: 200 });
    });
  };
  const entry = (name: string): CommandEntry => ({
    kind: 'tool',
    id: `tool:${name}`,
    label: name,
    tool: { name, description: '', mutates: true, fields: [] },
    keywords: [],
  });

  for (const name of ['publish', 'approve_publish_request'])
    it(`${name}: closes the menu to ask, and Publish anyway runs it again with allowSample`, async () => {
      const { store, askSampleText } = sampleStore(true);
      refusedOnce();
      store.getState().openCommandMenu();
      await store.getState().chooseCommand(entry(name));
      expect(askSampleText).toHaveBeenCalledWith('org_1', spots);
      expect(calls).toEqual([
        { name, input: {} },
        { name, input: { allowSample: true } },
      ]);
      expect(store.getState().commandMenu.open).toBe(false);
      expect(toast.error).not.toHaveBeenCalled();
    });

  it('Edit first runs nothing more, and says nothing went wrong', async () => {
    const { store } = sampleStore(false);
    refusedOnce();
    store.getState().openCommandMenu();
    await store.getState().chooseCommand(entry('publish'));
    expect(calls.map((c) => c.name)).toEqual(['publish']);
    expect(toast.error).not.toHaveBeenCalled();
    expect(store.getState().commandMenu.running).toBe(false);
  });
});
