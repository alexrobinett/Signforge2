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
  type TargetAction,
  type ToolListing,
} from '~/lib/command-menu';
import { callTool, callToolByName, toolMessage } from '~/lib/tools';
import type { AppStore, SliceCreator, StoreDeps } from './store';

interface CommandMenuState {
  open: boolean;
  /** What is typed in the list's search: past the sections and tools, it finds screens and groups. */
  query: string;
  /** The tool whose form is showing, by name; null shows the list. */
  form: string | null;
  /** The screen or group whose actions are showing; null shows the list. */
  target: CommandTarget | null;
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
  backToCommands: () => void;
  searchCommands: (query: string) => void;
  /** Shows a found screen's or group's actions. */
  chooseTarget: (target: CommandTarget) => void;
  runTargetAction: (action: TargetAction) => Promise<void>;
  submitToolForm: (label: string, tool: ToolListing, form: FormData) => Promise<void>;
}

const CLOSED: CommandMenuState = { open: false, query: '', form: null, target: null, running: false, opening: 0, fieldError: null, pending: null };

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
      if (entry.kind === 'go') {
        set((s) => ({ commandMenu: closed(s.commandMenu) }));
        await router.navigate({ to: entry.to });
      } else if (needsInput(entry.tool)) {
        set((s) => ({ commandMenu: { ...s.commandMenu, form: entry.tool.name, fieldError: null } }));
      } else {
        await run(entry.label, entry.tool, {});
      }
    },
    // The search stays as typed, so Back returns to what it found.
    backToCommands: () => set((s) => ({ commandMenu: { ...s.commandMenu, form: null, target: null, fieldError: null } })),
    searchCommands: (query) => set((s) => ({ commandMenu: { ...s.commandMenu, query } })),
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
