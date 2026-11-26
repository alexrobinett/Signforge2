/**
 * The command menu (⌘K): open or closed, what is typed, the screen or group whose actions are showing,
 * and an action chosen: each opens the page's own dialog (#358), and a found screen's Identify or
 * Restart is sent from here. The entries come from the shell's loader and the screens list
 * (src/lib/command-menu.ts); a sent command's answer is a toast.
 */
import { toast } from 'sonner';
import type { CommandEntry, CommandTarget, PeopleAction, Selection, TargetAction } from '~/lib/command-menu';
import { orgOnScreen } from '~/lib/live';
import { callTool, toolMessage } from '~/lib/tools';
import { getNavCounts } from '~/server/nav-counts.functions';
import { changingOrg } from './orgs';
import type { AppStore, SliceCreator, StoreDeps } from './store';

interface CommandMenuState {
  open: boolean;
  /** What is typed in the list's search: it finds pages, actions, screens and groups. */
  query: string;
  /** The list's selected item, as cmdk reports it (`selectedItem` in src/lib/command-menu.ts); null until it has. */
  selection: Selection | null;
  /** The member moved the selection (keys, pointer) since they last typed: a list that lands then keeps their choice. */
  moved: boolean;
  /** The list is back from another view, so its search takes focus itself; on opening, Radix's focus trap gives it focus. */
  backed: boolean;
  /** The screen or group whose actions are showing; null shows the list. */
  target: CommandTarget | null;
  /** Showing the member's orgs, from "Switch organization…", instead of the commands. */
  choosingOrg: boolean;
  /** A call is on its way: kept through closing and opening again, so it is not sent twice. */
  running: boolean;
  /** Counts the openings: a call's answer closes the menu only while it is the opening that sent it. */
  opening: number;
  /**
   * Something is unpublished, by the count this opening read itself (`readDrafts`): Publish all is offered
   * then. False until that read has come back and worked, and after it fails.
   */
  drafts: boolean;
}

export interface CommandMenuSlice {
  commandMenu: CommandMenuState;
  openCommandMenu: () => void;
  closeCommandMenu: () => void;
  /**
   * The menu closed (its `onCloseAutoFocus`, which runs once its closing has played): focus goes back to what
   * had it as the menu opened (for a menu's content, which focus would open again, that menu's button), while
   * that is still on the page and shown; else to the page's main region. Only while focus is on nothing: by then the member may have
   * moved on (opened the org switcher), and taking focus from there would close it.
   */
  menuFocusBack: (e: Event) => void;
  chooseCommand: (entry: CommandEntry) => Promise<void>;
  /**
   * Asks the agent `question` (#270): the drawer opens with it, on the page shown, and the menu closes,
   * unless `keepOpen` (⌘Enter).
   */
  askFromMenu: (question: string, keepOpen: boolean) => void;
  backToCommands: () => void;
  searchCommands: (query: string) => void;
  /** cmdk moved the list's selection, to `value`, among the screens and groups found then (`foundValues`, as JSON). */
  selectCommand: (value: string, among: string) => void;
  /** The member moved the list's selection themselves, by key or pointer. */
  moveCommandSelection: () => void;
  /** Shows a found screen's or group's actions. */
  chooseTarget: (target: CommandTarget) => void;
  runTargetAction: (action: TargetAction) => Promise<void>;
  /** Closes the menu and switches to `org`, from its list of orgs. */
  chooseOrg: (org: { id: string; name: string }) => Promise<void>;
}

const CLOSED: CommandMenuState = {
  open: false,
  query: '',
  selection: null,
  moved: false,
  backed: false,
  target: null,
  choosingOrg: false,
  running: false,
  opening: 0,
  drafts: false,
};

/** The menu closed: what outlives an opening (a call on its way, the count) stays. */
const closed = (m: CommandMenuState): CommandMenuState => ({ ...CLOSED, running: m.running, opening: m.opening });

export const createCommandMenuSlice: SliceCreator<CommandMenuSlice> = (set, get, { router }) => {
  /** What had focus as the menu opened: outside state, nothing renders it. */
  let opener: Element | null = null;
  /** The count read the latest opening sent: only its answer, for that opening, may offer Publish all. */
  let draftsRead: Promise<unknown> | null = null;
  /**
   * Reads the count of unpublished changes for opening `from`, as its own request: not the sidebar's
   * cached count, nor a read of it in flight, which may have been sent before a change (a draft deleted)
   * and is joined by the cache, not repeated.
   */
  const readDrafts = async (from: number) => {
    const read = getNavCounts({ data: { fleet: false, approvals: false } });
    draftsRead = read;
    const drafts = await read.then(
      (c) => c.spots + c.playlists + c.schedule > 0,
      () => false,
    );
    if (draftsRead !== read) return;
    set((s) => (s.commandMenu.open && s.commandMenu.opening === from && s.commandMenu.drafts !== drafts ? { commandMenu: { ...s.commandMenu, drafts } } : s));
  };
  /** Starts a call from this opening, unless one is on its way; the opening it was sent from, or null. */
  const start = () => {
    if (get().commandMenu.running) return null;
    set((s) => ({ commandMenu: { ...s.commandMenu, running: true } }));
    return get().commandMenu.opening;
  };
  /** A call answered: the menu it was sent from closes when it worked, and a later opening is left as it is. */
  const finish = (from: number, ok: boolean) =>
    set((s) => {
      const m = { ...s.commandMenu, running: false };
      return { commandMenu: ok && m.open && m.opening === from ? closed(m) : m };
    });

  /** An action's own dialog, on its page (#358): the menu closes first, so focus goes to the dialog. */
  async function act(action: PeopleAction) {
    const orgId = orgOnScreen(router);
    set((s) => ({ commandMenu: closed(s.commandMenu) }));
    switch (action) {
      case 'pair': {
        // Already on Screens, its view and search stay under the dialog; from elsewhere it opens plain.
        const onScreens = router.state.location.pathname === '/screens';
        await router.navigate({ to: '/screens', search: (prev) => (onScreens ? { ...prev, pair: true as const } : { pair: true as const }) });
        return;
      }
      case 'new-spot':
        await router.navigate({ to: '/spots' });
        get().openNewSpot(true);
        return;
      case 'new-playlist':
        if (orgId) await get().startNewPlaylist(orgId);
        return;
      case 'new-entry':
        if (orgId) get().openNewEntry(orgId);
        return;
      case 'take-over':
        if (orgId) get().openTakeover(orgId);
        return;
      case 'publish-all':
        // The sidebar's question: it shows what goes, and publishes exactly that (#361).
        if (orgId) await get().askPublishAll(orgId);
    }
  }

  return {
    commandMenu: CLOSED,
    // The phone drawer has the menu's button: the menu takes its place.
    openCommandMenu: () => {
      opener = typeof document === 'undefined' ? null : document.activeElement;
      set((s) => ({
        commandMenu: { ...closed(s.commandMenu), open: true, opening: s.commandMenu.opening + 1 },
        ui: { ...s.ui, drawerOpen: false },
      }));
      if (orgOnScreen(router)) void readDrafts(get().commandMenu.opening);
    },
    menuFocusBack(e) {
      e.preventDefault();
      if (document.activeElement && document.activeElement !== document.body) return;
      // In a menu's content (⌘K pressed as a menu closed), the menu's button, which the content is labelled by.
      const menu = opener?.closest('[role="menu"]');
      const back = menu ? document.getElementById(menu.getAttribute('aria-labelledby') ?? '') : opener;
      const shown = back instanceof HTMLElement && back.isConnected && back !== document.body && back.checkVisibility();
      (shown ? back : document.getElementById('main'))?.focus();
    },
    closeCommandMenu: () => set((s) => ({ commandMenu: closed(s.commandMenu) })),
    chooseCommand: async (entry) => {
      switch (entry.kind) {
        case 'go':
          set((s) => ({ commandMenu: closed(s.commandMenu) }));
          await router.navigate({ to: entry.to });
          return;
        case 'action':
          await act(entry.action);
          return;
        case 'agent':
          if (changingOrg(get().orgs)) return;
          set((s) => ({ commandMenu: closed(s.commandMenu) }));
          // No button opened it: closing it, focus goes to the page.
          get().openAgentDrawer(null);
          return;
        case 'ask':
          get().askFromMenu(entry.question, false);
          return;
        case 'org':
          if (entry.action === 'switch') {
            set((s) => ({ commandMenu: { ...s.commandMenu, choosingOrg: true } }));
          } else {
            set((s) => ({ commandMenu: closed(s.commandMenu) }));
            get().openCreateOrg();
          }
      }
    },
    askFromMenu(question, keepOpen) {
      // Not while the org changes: the drawer is the next org's, and asks nothing until it is shown (#479).
      if (changingOrg(get().orgs)) return;
      if (!keepOpen) set((s) => ({ commandMenu: closed(s.commandMenu) }));
      get().openAgentDrawer(null);
      void get().askAgent(question);
    },
    // The search stays as typed, so Back returns to what it found.
    backToCommands: () => set((s) => ({ commandMenu: { ...s.commandMenu, target: null, choosingOrg: false, backed: true } })),
    searchCommands: (query) => set((s) => ({ commandMenu: { ...s.commandMenu, query, moved: false } })),
    selectCommand: (value, among) => set((s) => ({ commandMenu: { ...s.commandMenu, selection: { value, among } } })),
    moveCommandSelection: () => set((s) => (s.commandMenu.moved ? s : { commandMenu: { ...s.commandMenu, moved: true } })),
    chooseTarget: (target) => set((s) => ({ commandMenu: { ...s.commandMenu, target } })),
    async runTargetAction(action) {
      const close = () => set((s) => ({ commandMenu: closed(s.commandMenu) }));
      switch (action.kind) {
        case 'open-screen':
          close();
          await router.navigate({ to: '/screens/$screenId', params: { screenId: action.screenId } });
          return;
        case 'open-group':
          close();
          await router.navigate({ to: '/screens', search: { group: action.groupId } });
          return;
        case 'play-here':
        case 'take-over': {
          const orgId = orgOnScreen(router);
          close();
          if (!orgId) return;
          const preset = { target: 'screen', screenId: action.screenId } as const;
          if (action.kind === 'play-here') get().openNewEntry(orgId, preset);
          else get().openTakeover(orgId, preset);
          return;
        }
        case 'tool': {
          const from = start();
          if (from === null) return;
          try {
            await callTool(action.tool, { screenId: action.screenId });
            finish(from, true);
            toast.success(`${action.label}: ${action.screenName}`, { description: action.done });
          } catch (err) {
            finish(from, false);
            toast.error(`${action.label}: ${action.screenName}`, { description: toolMessage(err) });
          }
        }
      }
    },
    chooseOrg: async (org) => {
      set((s) => ({ commandMenu: closed(s.commandMenu) }));
      await get().switchOrg(org, 'switcher');
    },
  };
};

/** Browser only, once per store: ⌘K or Ctrl+K opens the menu from any page, and again closes it. */
export function connectCommandMenu(store: AppStore, { router }: StoreDeps) {
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    e.preventDefault();
    const { commandMenu, openCommandMenu, closeCommandMenu } = store.getState();
    if (commandMenu.open) closeCommandMenu();
    else openCommandMenu();
  });
  router.subscribe('onBeforeNavigate', ({ pathChanged }) => {
    if (pathChanged && store.getState().commandMenu.open) store.getState().closeCommandMenu();
  });
}
