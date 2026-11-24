/**
 * The command menu (⌘K): open or closed, what is typed, the tool whose form or the screen or group
 * whose actions are showing, and running a tool or an action. The entries come from the shell's
 * loader and the screens list (src/lib/command-menu.ts); results and refusals are toasts.
 */
import { toast } from 'sonner';
import {
  needsInput,
  resultText,
  toolInput,
  withKey,
  type CommandEntry,
  type CommandTarget,
  type PendingCall,
  type Selection,
  type TargetAction,
  type ToolListing,
} from '~/lib/command-menu';
import { orgOnScreen } from '~/lib/live';
import { callTool, callToolByName, toolMessage } from '~/lib/tools';
import type { AppStore, SliceCreator, StoreDeps } from './store';

interface CommandMenuState {
  open: boolean;
  /** What is typed in the list's search: past the sections and tools, it finds screens and groups. */
  query: string;
  /** The tool whose form is showing, by name; null shows the list. */
  form: string | null;
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
  /** A form field the menu could not read, before anything was sent. */
  fieldError: { field: string; message: string } | null;
  /** The last call that did not succeed: sent again with the same input, it keeps its idempotency key, closed or not. */
  pending: PendingCall | null;
}

export interface CommandMenuSlice {
  commandMenu: CommandMenuState;
  openCommandMenu: () => void;
  closeCommandMenu: () => void;
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
  submitToolForm: (label: string, tool: ToolListing, form: FormData) => Promise<void>;
}

const CLOSED: CommandMenuState = {
  open: false,
  query: '',
  selection: null,
  moved: false,
  backed: false,
  form: null,
  target: null,
  choosingOrg: false,
  running: false,
  opening: 0,
  fieldError: null,
  pending: null,
};

/** The menu closed: what outlives an opening (a call on its way, the last one that failed, the count) stays. */
const closed = (m: CommandMenuState): CommandMenuState => ({ ...CLOSED, running: m.running, opening: m.opening, pending: m.pending });

export const createCommandMenuSlice: SliceCreator<CommandMenuSlice> = (set, get, { router }) => {
  /** Starts a call from this opening, unless one is on its way; the opening it was sent from, or null. */
  const start = (change: (m: CommandMenuState) => Partial<CommandMenuState> = () => ({})) => {
    if (get().commandMenu.running) return null;
    set((s) => ({ commandMenu: { ...s.commandMenu, running: true, ...change(s.commandMenu) } }));
    return get().commandMenu.opening;
  };
  /** A call answered: the menu it was sent from closes when it worked, and a later opening is left as it is. A tool's call also settles its `pending`. */
  const finish = (from: number, ok: boolean, pending?: PendingCall | null) =>
    set((s) => {
      const m = { ...s.commandMenu, running: false, ...(pending === undefined ? {} : { pending }) };
      return { commandMenu: ok && m.open && m.opening === from ? closed(m) : m };
    });

  const run = async (label: string, tool: ToolListing, read: Record<string, unknown>) => {
    const { input, pending } = withKey(tool, read, get().commandMenu.pending);
    const from = start(() => ({ fieldError: null, pending }));
    if (from === null) return;
    try {
      const output = await callToolByName(tool.name, input);
      finish(from, true, null);
      toast.success(label, { description: resultText(output) });
      if (tool.mutates) await router.invalidate();
    } catch (err) {
      finish(from, false, pending);
      toast.error(label, { description: toolMessage(err) });
    }
  };

  return {
    commandMenu: CLOSED,
    // The phone drawer has the menu's button: the menu takes its place.
    openCommandMenu: () =>
      set((s) => ({ commandMenu: { ...closed(s.commandMenu), open: true, opening: s.commandMenu.opening + 1 }, ui: { ...s.ui, drawerOpen: false } })),
    closeCommandMenu: () => set((s) => ({ commandMenu: closed(s.commandMenu) })),
    chooseCommand: async (entry) => {
      switch (entry.kind) {
        case 'go':
          set((s) => ({ commandMenu: closed(s.commandMenu) }));
          await router.navigate({ to: entry.to });
          return;
        case 'takeover': {
          const orgId = orgOnScreen(router);
          set((s) => ({ commandMenu: closed(s.commandMenu) }));
          if (orgId) get().openTakeover(orgId);
          return;
        }
        case 'tool':
          if (needsInput(entry.tool)) set((s) => ({ commandMenu: { ...s.commandMenu, form: entry.tool.name, fieldError: null } }));
          else await run(entry.label, entry.tool, {});
          return;
        case 'agent':
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
      if (!keepOpen) set((s) => ({ commandMenu: closed(s.commandMenu) }));
      get().openAgentDrawer(null);
      void get().askAgent(question);
    },
    // The search stays as typed, so Back returns to what it found.
    backToCommands: () => set((s) => ({ commandMenu: { ...s.commandMenu, form: null, target: null, choosingOrg: false, fieldError: null, backed: true } })),
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
    submitToolForm: async (label, tool, form) => {
      if (get().commandMenu.running) return;
      const read = toolInput(tool.fields, form);
      if (!read.ok) {
        set((s) => ({ commandMenu: { ...s.commandMenu, fieldError: { field: read.field, message: read.message } } }));
        return;
      }
      await run(label, tool, read.input);
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
