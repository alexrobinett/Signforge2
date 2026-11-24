/**
 * The agent's drawer (#267, docs/proposals/cms-agent.md): open or not, the page it was opened on, the
 * conversation, and the turn on its way. A turn (`POST /api/agent/chat`) streams one JSON object a
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
  page: ChatRequestBody['page'];
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
  /** Asks `question`, or the one typed, with the conversation so far. */
  askAgent: (question?: string) => Promise<void>;
}

const IN_SETTINGS = new Set(['no_model', 'model_refused']);

/** The record ids in the page's path, as its route names them: what "this screen" means. */
const idsOf = (params: unknown): Record<string, string> =>
  typeof params === 'object' && params !== null
    ? Object.fromEntries(Object.entries(params).filter((e): e is [string, string] => typeof e[1] === 'string'))
    : {};

export const createAgentDrawerSlice: SliceCreator<AgentDrawerSlice> = (set, get, { router }) => {
  const drawer = (change: (d: AgentDrawerState) => AgentDrawerState) => set((s) => ({ agentDrawer: change(s.agentDrawer) }));
  const say = (message: DrawerMessage) => drawer((d) => ({ ...d, messages: [...d.messages, message] }));

  /** One line of the turn's stream, into the drawer. */
  function hear(event: ChatEvent) {
    if (event.type === 'call') drawer((d) => ({ ...d, progress: [...d.progress, event.item] }));
    else if (event.type === 'answer') say({ role: 'assistant', card: event.card });
    else say({ role: 'error', text: event.message, inSettings: IN_SETTINGS.has(event.error) });
  }

  return {
    agentDrawer: { open: false, page: { path: '/', ids: {} }, messages: [], question: '', asking: false, progress: [], opener: null },

    openAgentDrawer(opener) {
      const match = router.state.matches.at(-1);
      drawer((d) => ({ ...d, open: true, opener, page: { path: router.state.location.pathname, ids: idsOf(match?.params) } }));
      get().setRightPanel(true);
    },

    closeAgentDrawer() {
      drawer((d) => ({ ...d, open: false }));
      get().setRightPanel(false);
    },

    editQuestion: (question) => drawer((d) => ({ ...d, question })),

    async askAgent(asked) {
      const { question: typed, asking: busy, messages, page } = get().agentDrawer;
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
      try {
        const headers = { 'content-type': 'application/json', ...(await tabOrgHeaders()) };
        const body: ChatRequestBody = { messages: history, page };
        const res = await fetch('/api/agent/chat', { method: 'POST', headers, body: JSON.stringify(body) }).catch((cause: unknown) => {
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
        drawer((d) => ({ ...d, asking: false, progress: [] }));
      }
    },
  };
};
