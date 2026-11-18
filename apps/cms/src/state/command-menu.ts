/**
 * The command menu (⌘K): open or closed, the tool whose form is showing, and running a tool. The
 * entries come from the shell's loader (src/lib/command-menu.ts); results and refusals are toasts.
 */
import { toast } from 'sonner';
import { needsInput, resultText, toolInput, withKey, type CommandEntry, type PendingCall, type ToolListing } from '~/lib/command-menu';
import { callTool, toolMessage } from '~/lib/tools';
import type { AppStore, SliceCreator, StoreDeps } from './store';

interface CommandMenuState {
  open: boolean;
  /** The tool whose form is showing, by name; null shows the list. */
  form: string | null;
  running: boolean;
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
  submitToolForm: (label: string, tool: ToolListing, form: FormData) => Promise<void>;
}

const CLOSED: CommandMenuState = { open: false, form: null, running: false, fieldError: null, pending: null };

export const createCommandMenuSlice: SliceCreator<CommandMenuSlice> = (set, get, { router }) => {
  const run = async (label: string, tool: ToolListing, read: Record<string, unknown>) => {
    const { input, pending } = withKey(tool, read, get().commandMenu.pending);
    set((s) => ({ commandMenu: { ...s.commandMenu, running: true, fieldError: null, pending } }));
    try {
      const output = await callTool(tool.name, input);
      set({ commandMenu: CLOSED });
      toast.success(label, { description: resultText(output) });
      if (tool.mutates) await router.invalidate();
    } catch (err) {
      set((s) => ({ commandMenu: { ...s.commandMenu, running: false } }));
      toast.error(label, { description: toolMessage(err) });
    }
  };

  return {
    commandMenu: CLOSED,
    // The phone drawer has the menu's button: the menu takes its place.
    openCommandMenu: () => set((s) => ({ commandMenu: { ...CLOSED, open: true, pending: s.commandMenu.pending }, ui: { ...s.ui, drawerOpen: false } })),
    closeCommandMenu: () => set((s) => ({ commandMenu: { ...CLOSED, pending: s.commandMenu.pending } })),
    chooseCommand: async (entry) => {
      if (entry.kind === 'go') {
        set((s) => ({ commandMenu: { ...CLOSED, pending: s.commandMenu.pending } }));
        await router.navigate({ to: entry.to });
      } else if (needsInput(entry.tool)) {
        set((s) => ({ commandMenu: { ...s.commandMenu, form: entry.tool.name, fieldError: null } }));
      } else {
        await run(entry.label, entry.tool, {});
      }
    },
    backToCommands: () => set((s) => ({ commandMenu: { ...s.commandMenu, form: null, fieldError: null } })),
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
