// ⌘K's found screens and groups in the store (#180): what is typed, the actions shown, and an
// action run (a tool call, through a stubbed `fetch`, or a navigation). Nothing waits on a clock.
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { CommandEntry, TargetAction } from '../src/lib/command-menu';
import { createCommandMenuSlice, type CommandMenuSlice } from '../src/state/command-menu';
import { toast } from 'sonner';
import { initialOrgs, type OrgsState } from '../src/state/orgs';
import { getNavCounts } from '~/server/nav-counts.functions';

vi.mock('~/lib/tab-org', () => ({ tabOrgHeaders: async () => ({}) }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock('~/server/screens.functions', () => ({ getScreenStatus: vi.fn(), getScreens: vi.fn() }));
vi.mock('~/server/nav-counts.functions', () => ({ getNavCounts: vi.fn(async () => ({ spots: 0, playlists: 0, schedule: 0 })) }));

let calls: { name: string; input: unknown }[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };

function menuStore() {
  const router = { navigate: vi.fn(async () => {}), invalidate: vi.fn(async () => {}), state: { matches: [] } };
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

describe('opening the menu (#454)', () => {
  /** The menu's store on a page of org_1, its shell listing these tools for the member. */
  const onPage = (tools: string[]) => {
    const { store, router } = menuStore();
    router.state.matches = [{ routeId: '/_app', loaderData: { organization: { id: 'org_1' }, tools: tools.map((name) => ({ name })) } }] as never;
    return store;
  };

  it('reads the count of unpublished changes for a member who may publish, and not for one who may not', () => {
    vi.mocked(getNavCounts).mockClear();
    onPage(['read', 'publish']).getState().openCommandMenu();
    expect(getNavCounts).toHaveBeenCalledOnce();
    vi.mocked(getNavCounts).mockClear();
    // A viewer, or an editor where only owners publish: Publish all is never offered, so nothing is read.
    onPage(['read', 'save_spot']).getState().openCommandMenu();
    expect(getNavCounts).not.toHaveBeenCalled();
  });
});

const identify: TargetAction = {
  kind: 'command',
  label: 'Identify (10 s)',
  command: 'identify',
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
  const restart: TargetAction = { kind: 'command', label: 'Restart player', command: 'restart', screenId: 'scr_1', screenName: 'Lobby', done: 'Sent.' };

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
    expect(calls).toEqual([{ name: 'screen_command', input: { screenId: 'scr_1', command: 'restart' } }]);

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
    expect(calls).toEqual([{ name: 'screen_command', input: { screenId: 'scr_1', command: 'identify' } }]);
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

describe("⌘K's actions open the page's own dialogs (#358)", () => {
  /** ⌘K on a page of org_1, with the dialogs it opens as spies. */
  function actionStore() {
    const router = {
      navigate: vi.fn(async () => {}),
      invalidate: vi.fn(async () => {}),
      state: { matches: [{ routeId: '/_app', loaderData: { organization: { id: 'org_1' } } }], location: { pathname: '/spots' } },
    };
    const dialogs = {
      openNewSpot: vi.fn(),
      startNewPlaylist: vi.fn(async () => {}),
      openNewEntry: vi.fn(),
      openTakeover: vi.fn(),
      askPublishAll: vi.fn(async () => {}),
    };
    const store = createStore<CommandMenuSlice & { ui: object } & typeof dialogs>()((set, get) => ({
      ui: {},
      ...dialogs,
      ...createCommandMenuSlice(set as never, get as never, { router, queryClient: new QueryClient() } as never),
    }));
    return { store, router, dialogs };
  }
  const action = (a: Extract<CommandEntry, { kind: 'action' }>['action']): CommandEntry => ({
    kind: 'action',
    id: `action:${a}`,
    label: a,
    action: a,
    keywords: [],
  });

  it("Pair a screen opens the Screens page with its dialog, through the URL, keeping Screens' own search when already there", async () => {
    const { store, router } = actionStore();
    store.getState().openCommandMenu();
    await store.getState().chooseCommand(action('pair'));
    const [from] = router.navigate.mock.calls.at(-1) as unknown as [{ to: string; search: (prev: object) => object }];
    expect(from.to).toBe('/screens');
    // From another page, its search is not carried: Screens opens plain, with the dialog.
    expect(from.search({ o: 'portrait' })).toEqual({ pair: true });
    expect(store.getState().commandMenu.open).toBe(false);
    router.state.location.pathname = '/screens';
    await store.getState().chooseCommand(action('pair'));
    const [on] = router.navigate.mock.calls.at(-1) as unknown as [{ search: (prev: object) => object }];
    expect(on.search({ view: 'table', q: 'lobby' })).toEqual({ view: 'table', q: 'lobby', pair: true });
  });

  it('New spot and New playlist open their pages and their dialogs', async () => {
    const { store, router, dialogs } = actionStore();
    await store.getState().chooseCommand(action('new-spot'));
    expect(router.navigate).toHaveBeenLastCalledWith({ to: '/spots' });
    expect(dialogs.openNewSpot).toHaveBeenCalledWith(true);
    // New playlist through the editor's own start, which leaves no dialog asked for with no spot (review of #458).
    await store.getState().chooseCommand(action('new-playlist'));
    expect(dialogs.startNewPlaylist).toHaveBeenCalledWith('org_1');
  });

  it('Add to the schedule, Take over and Publish all open the shell dialogs, for the org on screen, and call no tool', async () => {
    const { store, dialogs } = actionStore();
    await store.getState().chooseCommand(action('new-entry'));
    await store.getState().chooseCommand(action('take-over'));
    await store.getState().chooseCommand(action('publish-all'));
    expect(dialogs.openNewEntry).toHaveBeenCalledWith('org_1');
    expect(dialogs.openTakeover).toHaveBeenCalledWith('org_1');
    // The sidebar's question: it shows what goes and publishes exactly that (#361).
    expect(dialogs.askPublishAll).toHaveBeenCalledWith('org_1');
    expect(calls).toEqual([]);
  });
});

describe('asking the agent from the menu (#270)', () => {
  /** The menu with the drawer's two actions it calls, recorded. */
  function asking() {
    const asked: { opened: number; questions: string[] } = { opened: 0, questions: [] };
    const store = createStore<CommandMenuSlice & { ui: object; orgs: OrgsState; openAgentDrawer: () => void; askAgent: (q: string) => Promise<void> }>()(
      (set, get) => ({
        ui: {},
        orgs: initialOrgs,
        openAgentDrawer: () => void asked.opened++,
        askAgent: async (q: string) => void asked.questions.push(q),
        ...createCommandMenuSlice(set as never, get as never, { router: { navigate: vi.fn(), invalidate: vi.fn(), state: { matches: [] } } } as never),
      }),
    );
    return { store, asked };
  }

  it('opens the drawer and asks the question; Enter closes the menu, ⌘Enter keeps it open', async () => {
    const { store, asked } = asking();
    store.getState().openCommandMenu();
    await store
      .getState()
      .chooseCommand({ kind: 'ask', id: 'ask:typed', label: 'Ask agent: why are screens behind', question: 'why are screens behind', keywords: [] });
    expect(asked).toEqual({ opened: 1, questions: ['why are screens behind'] });
    expect(store.getState().commandMenu.open).toBe(false);
    store.getState().openCommandMenu();
    store.getState().askFromMenu('what plays now', true);
    expect(asked.questions).toEqual(['why are screens behind', 'what plays now']);
    expect(store.getState().commandMenu.open).toBe(true);
  });

  it('asks nothing, and opens no drawer, while the org changes (#479)', async () => {
    const { store, asked } = asking();
    store.setState({ orgs: { ...initialOrgs, switchingTo: 'org_2' } });
    store.getState().openCommandMenu();
    store.getState().askFromMenu('what plays now', false);
    await store.getState().chooseCommand({ kind: 'agent', id: 'agent', label: 'Ask the agent…', keywords: [] });
    expect(asked).toEqual({ opened: 0, questions: [] });
  });
});
