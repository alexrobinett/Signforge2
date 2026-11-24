/**
 * The agent's drawer (#267, docs/proposals/cms-agent.md): open or not, the conversation, and the
 * turn on its way, which is asked with the page shown when it is asked. A turn (`POST /api/agent/chat`) streams one JSON object a
 * line: each tool call as it runs, shown as progress, then the answer as a card, or why it ended. The
 * conversation lives only here, so a reload forgets it; each question sends it back, the last
 * `CHAT_HISTORY` messages of it.
 */
import { type AnswerCard, CHAT_HISTORY, type ChatEvent, type ChatRequestBody, type TraceItem } from '@signforge/api/agent-chat';
import { tabOrgHeaders } from '~/lib/tab-org';
import { Refusal, refusalOf, toolMessage } from '~/lib/tools';
import type { SliceCreator } from './store';

type DrawerMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; card: AnswerCard }
  /** Why a turn gave no answer; `inSettings` when an owner mends it in Settings, AI & agents. */
  | { role: 'error'; text: string; inSettings: boolean };

type AgentOpener = 'sidebar' | 'top-bar';

interface AgentDrawerState {
  open: boolean;
  messages: DrawerMessage[];
  question: string;
  asking: boolean;
  /** The turn's tool calls so far, in words. */
  progress: TraceItem[];
  /**
   * Which button opened the drawer, where focus goes back when it closes: the sidebar's (which the
   * drawer folds, so its element is another by then) or the top bar's; none from the command menu.
   */
  opener: AgentOpener | null;
}

export interface AgentDrawerSlice {
  agentDrawer: AgentDrawerState;
  /** Opens the drawer on the page now shown, from `opener`; it folds the sidebar to make room. */
  openAgentDrawer: (opener: AgentOpener | null) => void;
  closeAgentDrawer: () => void;
  editQuestion: (question: string) => void;
  /** Asks `question`, or the one typed, with the conversation so far and the page shown now. */
  askAgent: (question?: string) => Promise<void>;
  /**
   * The org is changing (`switchOrg`): the conversation, and any turn on its way, were the old
   * org's. Both go, so nothing of it reaches the new org's model or lands in its drawer.
   */
  forgetAgentDrawer: () => void;
}

const IN_SETTINGS = new Set(['no_model', 'model_refused']);

/** The record ids in the page's path, as its route names them: what "this screen" means. */
const idsOf = (params: unknown): Record<string, string> =>
  typeof params === 'object' && params !== null
    ? Object.fromEntries(Object.entries(params).filter((e): e is [string, string] => typeof e[1] === 'string'))
    : {};

const closed = (): AgentDrawerState => ({ open: false, messages: [], question: '', asking: false, progress: [], opener: null });

export const createAgentDrawerSlice: SliceCreator<AgentDrawerSlice> = (set, get, { router }) => {
  const drawer = (change: (d: AgentDrawerState) => AgentDrawerState) => set((s) => ({ agentDrawer: change(s.agentDrawer) }));
  /** The turn on its way: forgetting the drawer stops it, and what it would still say is dropped. */
  let running: AbortController | null = null;

  return {
    agentDrawer: closed(),

    openAgentDrawer(opener) {
      drawer((d) => ({ ...d, open: true, opener }));
      get().setRightPanel(true);
    },

    forgetAgentDrawer() {
      running?.abort();
      running = null;
      const { open } = get().agentDrawer;
      set({ agentDrawer: closed() });
      if (open) get().setRightPanel(false);
    },

    closeAgentDrawer() {
      drawer((d) => ({ ...d, open: false }));
      get().setRightPanel(false);
    },

    editQuestion: (question) => drawer((d) => ({ ...d, question })),

    async askAgent(asked) {
      const { question: typed, asking: busy, messages } = get().agentDrawer;
      // The page shown now: the person may have moved since the drawer opened.
      const page = { path: router.state.location.pathname, ids: idsOf(router.state.matches.at(-1)?.params) };
      const question = (asked ?? typed).trim();
      if (!question || busy) return;
      type Said = ChatRequestBody['messages'][number];
      const said = messages.flatMap((m): Said[] =>
        m.role === 'user' ? [{ role: 'user', text: m.text }] : m.role === 'assistant' ? [{ role: 'assistant', text: m.card.text }] : [],
      );
      const asking: Said = { role: 'user', text: question };
      const history: Said[] = [...said, asking].slice(-CHAT_HISTORY);
      // The history must start with the person's words.
      while (history[0]?.role === 'assistant') history.shift();
      drawer((d) => ({ ...d, messages: [...d.messages, { role: 'user', text: question }], question: asked ? d.question : '', asking: true, progress: [] }));
      const turn = new AbortController();
      running = turn;
      // Only this turn's, while it is the drawer's: once forgotten, it changes nothing.
      const mine = (change: (d: AgentDrawerState) => AgentDrawerState) => {
        if (running === turn) drawer(change);
      };
      const say = (message: DrawerMessage) => mine((d) => ({ ...d, messages: [...d.messages, message] }));
      const hear = (event: ChatEvent) => {
        if (event.type === 'call') mine((d) => ({ ...d, progress: [...d.progress, event.item] }));
        else if (event.type === 'answer') say({ role: 'assistant', card: event.card });
        else say({ role: 'error', text: event.message, inSettings: IN_SETTINGS.has(event.error) });
      };
      try {
        const headers = { 'content-type': 'application/json', ...(await tabOrgHeaders()) };
        const body: ChatRequestBody = { messages: history, page };
        const res = await fetch('/api/agent/chat', { method: 'POST', headers, body: JSON.stringify(body), signal: turn.signal }).catch((cause: unknown) => {
          throw new Refusal('network', 'Could not reach SignForge. Check your connection and try again.', undefined, { cause });
        });
        if (!res.ok || !res.body) throw await refusalOf(res, `Something went wrong (${res.status}).`);
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let rest = '';
        for (let read = await reader.read(); !read.done; read = await reader.read()) {
          const lines = (rest + read.value).split('\n');
          rest = lines.pop() ?? '';
          for (const line of lines) if (line.trim()) hear(JSON.parse(line));
        }
        if (rest.trim()) hear(JSON.parse(rest));
      } catch (err) {
        say({ role: 'error', text: toolMessage(err), inSettings: err instanceof Refusal && IN_SETTINGS.has(err.code) });
      } finally {
        mine((d) => ({ ...d, asking: false, progress: [] }));
        if (running === turn) running = null;
      }
    },
  };
};
