/**
 * The agent's drawer (#267, docs/proposals/cms-agent.md): open or not, the conversation, and the
 * turn on its way, which is asked with the page shown when it is asked. A turn (`POST /api/agent/chat`) streams one JSON object a
 * line: each tool call as it runs, shown as progress, then the answer as a card, or why it ended. The
 * conversation lives only here, so a reload forgets it; each question sends it back, the last
 * `CHAT_HISTORY` messages of it.
 *
 * An answer may hold drafts (#268): changes the agent proposes, written only when the person saves
 * them (`POST /api/agent/apply`). Their summary and reach are worked out here, from the pages' own
 * reads (src/lib/draft-summary.ts). Saved, a spot's changed fields are marked in its editor, as the
 * agent's update marks them (#264); Undo these changes puts each back as it was, as the person, with
 * `ifVersion`, in reverse order.
 */
import {
  type AnswerCard,
  type ApplyAnswer,
  CHAT_HISTORY,
  type ChatEvent,
  type ChatRequestBody,
  type ProposedCall,
  type TraceItem,
} from '@signforge/api/agent-chat';
import type { FieldMark } from '@signforge/api/agent-inline';
import { orgOnScreen } from '~/lib/live';
import { type DraftSummary, summarize } from '~/lib/draft-summary';
import { versionsById } from '~/lib/spots';
import { tabOrgHeaders } from '~/lib/tab-org';
import { callToolByName, Refusal, refusalOf, toolMessage } from '~/lib/tools';
import { playlistsQuery } from '~/queries/playlists';
import { scheduleQuery } from '~/queries/schedule';
import { screensQuery } from '~/queries/screens';
import { spotsQuery, templatesQuery } from '~/queries/spots';
import type { SliceCreator } from './store';

/** An answer's drafts: proposed, saving, saved (or refused at the first that was), then undone or published. */
interface Drafts {
  status: 'proposed' | 'saving' | 'saved' | 'refused' | 'undoing' | 'undone' | 'publishing' | 'published';
  /** By draft, once worked out; empty until then, or if the pages' reads failed. */
  summaries: DraftSummary[];
  /** What the save wrote, in order: the last refused, when one was. */
  results: ApplyAnswer['results'];
  error: string | null;
  /** "Publish now…" pressed: the question shown, and Publish to confirm. */
  confirming: boolean;
}

type DrawerMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; card: AnswerCard; drafts: Drafts | null }
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
  /** Saves the drafts of the answer at `index` (#268). */
  saveDrafts: (index: number) => Promise<void>;
  /** Puts back, as the person, what the saved drafts of the answer at `index` changed. */
  undoDrafts: (index: number) => Promise<void>;
  /** Publish now… pressed, or let go. */
  confirmPublish: (index: number, confirming: boolean) => void;
  /** Publishes what the saved drafts of the answer at `index` changed. */
  publishDrafts: (index: number) => Promise<void>;
}

type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Each drafting tool's target in its input and in its output, for Undo and Publish. */
const TARGETS: Record<string, { id: string; out: string }> = {
  update_spot: { id: 'spotId', out: 'spot' },
  update_playlist: { id: 'playlistId', out: 'playlist' },
  update_schedule_entry: { id: 'scheduleEntryId', out: 'entry' },
  create_schedule_entry: { id: 'scheduleEntryId', out: 'entry' },
  rename_screen: { id: 'screenId', out: 'screen' },
};

/** A saved draft's record, as its tool gave it back. */
const savedOf = (tool: string, output: unknown): Row | undefined => {
  const out = TARGETS[tool]?.out;
  const v = out && isRow(output) ? output[out] : undefined;
  return isRow(v) ? v : undefined;
};

/**
 * The call that puts a saved draft back: a creation deleted; an update given back each value it
 * changed, as the draft read it, at the version the save left.
 */
function undoOf(call: ProposedCall, output: unknown): { tool: string; input: Row } | undefined {
  const t = TARGETS[call.tool];
  const saved = savedOf(call.tool, output);
  if (!t || !saved) return undefined;
  if (call.tool === 'create_schedule_entry') return { tool: 'delete_schedule_entry', input: { scheduleEntryId: saved.id } };
  const before = call.before ?? {};
  const keys = Object.keys(call.input).filter((k) => k !== t.id && k !== 'ifVersion');
  return { tool: call.tool, input: { [t.id]: saved.id, ...Object.fromEntries(keys.map((k) => [k, before[k] ?? null])), ifVersion: saved.version } };
}

const IN_SETTINGS = new Set(['no_model', 'model_refused']);

/** The record ids in the page's path, as its route names them: what "this screen" means. */
const idsOf = (params: unknown): Record<string, string> =>
  typeof params === 'object' && params !== null
    ? Object.fromEntries(Object.entries(params).filter((e): e is [string, string] => typeof e[1] === 'string'))
    : {};

const closed = (): AgentDrawerState => ({ open: false, messages: [], question: '', asking: false, progress: [], opener: null });

export const createAgentDrawerSlice: SliceCreator<AgentDrawerSlice> = (set, get, { router, queryClient }) => {
  const drawer = (change: (d: AgentDrawerState) => AgentDrawerState) => set((s) => ({ agentDrawer: change(s.agentDrawer) }));
  /** The turn on its way: forgetting the drawer stops it, and what it would still say is dropped. */
  let running: AbortController | null = null;

  /** The drafts of the answer at `index`, changed; nothing if it holds none (forgotten since). */
  const drafts = (index: number, change: (d: Drafts) => Drafts) =>
    drawer((d) => ({
      ...d,
      messages: d.messages.map((m, i) => (i === index && m.role === 'assistant' && m.drafts ? { ...m, drafts: change(m.drafts) } : m)),
    }));
  const draftsAt = (index: number) => {
    const m = get().agentDrawer.messages[index];
    return m?.role === 'assistant' && m.drafts ? { card: m.card, drafts: m.drafts } : undefined;
  };

  /** The drafts' summaries and reach, from the pages' own reads of the org: a help, so a read that fails leaves them out. */
  async function summarizeAt(index: number, calls: ProposedCall[]) {
    const orgId = orgOnScreen(router);
    if (!orgId) return;
    const summaries = await Promise.all([
      queryClient.query(screensQuery(orgId)),
      queryClient.query(scheduleQuery(orgId)),
      queryClient.query(playlistsQuery(orgId)),
      queryClient.query(spotsQuery(orgId)),
      queryClient.query(templatesQuery(orgId)),
    ]).then(
      ([fleet, schedule, playlists, spots, templates]) => {
        const versions = versionsById(templates.templates);
        const context = {
          screens: fleet.screens,
          groups: fleet.groups,
          entries: schedule.entries,
          playlists: playlists.playlists,
          spots: spots.spots,
          fieldsOf: (id: string) => versions.get(id)?.manifest.fields,
          at: new Date(),
        };
        return calls.map((call) => summarize(call, context));
      },
      (): DraftSummary[] => [],
    );
    drafts(index, (d) => ({ ...d, summaries }));
  }

  /** A saved spot draft's changed fields, marked in its editor until edited or Done, as the agent's update marks them (#264). */
  function markSpot(call: ProposedCall, output: unknown) {
    const spot = savedOf(call.tool, output);
    const orgId = orgOnScreen(router);
    if (call.tool !== 'update_spot' || !spot || !orgId || !isRow(call.before)) return;
    const versions = versionsById(queryClient.getQueryData(templatesQuery(orgId).queryKey)?.templates ?? []);
    const fields = versions.get(String(call.before.templateVersionId))?.manifest.fields ?? {};
    const was = isRow(call.before.data) ? call.before.data : {};
    const now = isRow(call.input.data) ? call.input.data : was;
    // Each field whose value the save changed: by the template's fields, or by the data's own keys while they are not read.
    const names = Object.keys(fields).length ? Object.keys(fields) : [...new Set([...Object.keys(was), ...Object.keys(now)])];
    const changed = names.filter((f) => JSON.stringify(was[f] ?? null) !== JSON.stringify(now[f] ?? null));
    const marks = Object.fromEntries(
      changed.map((f): [string, FieldMark] =>
        fields[f]?.type === 'url'
          ? [f, { state: 'check', note: 'A link the agent added: check where it goes', links: [String(now[f] ?? '')] }]
          : [f, { state: 'filled' }],
      ),
    );
    set((s) => ({
      agent: {
        ...s.agent,
        filled: {
          ...s.agent.filled,
          [String(spot.id)]: {
            kind: 'update',
            marks,
            before: Object.fromEntries(changed.map((f) => [f, was[f]])),
            wrote: Object.fromEntries(changed.map((f) => [f, now[f]])),
            changed: changed.length,
            alsoOn: [],
            photo: null,
            link: '',
            uploading: false,
            uploadError: null,
          },
        },
      },
    }));
  }

  return {
    agentDrawer: closed(),

    async saveDrafts(index) {
      const at = draftsAt(index);
      const orgId = orgOnScreen(router);
      if (!at || !orgId || at.drafts.status !== 'proposed') return;
      drafts(index, (d) => ({ ...d, status: 'saving', error: null }));
      try {
        const headers = { 'content-type': 'application/json', ...(await tabOrgHeaders()) };
        const calls = at.card.drafts.map(({ tool, input }) => ({ tool, input }));
        const res = await fetch('/api/agent/apply', { method: 'POST', headers, body: JSON.stringify({ calls }) }).catch((cause: unknown) => {
          throw new Refusal('network', 'Could not reach SignForge. Check your connection and try again.', undefined, { cause });
        });
        const body: unknown = await res.json().catch(() => null);
        if (!isRow(body) || !Array.isArray(body.results)) throw await refusalOf(res, `Something went wrong (${res.status}).`);
        const answer: ApplyAnswer = { results: body.results };
        const refused = answer.results.find((r): r is Extract<ApplyAnswer['results'][number], { ok: false }> => !r.ok);
        answer.results.forEach((r, i) => {
          const call = at.card.drafts[i];
          if (r.ok && call) markSpot(call, r.output);
        });
        // Every page reads again what changed: the editor shows the spot as saved, and its stage plays it.
        await queryClient.invalidateQueries({ queryKey: ['org', orgId] });
        for (const [i, r] of answer.results.entries()) {
          const spot = r.ok ? savedOf(r.tool, r.output) : undefined;
          if (r.tool === 'update_spot' && spot) await get().reloadSpot(orgId, String(at.card.drafts[i]?.target?.id ?? spot.id));
        }
        drafts(index, (d) => ({
          ...d,
          results: answer.results,
          status: refused ? 'refused' : 'saved',
          error: refused?.message ?? null,
        }));
      } catch (err) {
        drafts(index, (d) => ({ ...d, status: 'proposed', error: toolMessage(err) }));
      }
    },

    async undoDrafts(index) {
      const at = draftsAt(index);
      const orgId = orgOnScreen(router);
      if (!at || !orgId || (at.drafts.status !== 'saved' && at.drafts.status !== 'refused')) return;
      drafts(index, (d) => ({ ...d, status: 'undoing', error: null }));
      try {
        // The last saved first: what each put back is what it found.
        for (const [i, r] of [...at.drafts.results.entries()].reverse()) {
          const call = at.card.drafts[i];
          const undo = r.ok && call ? undoOf(call, r.output) : undefined;
          if (undo) await callToolByName(undo.tool, undo.input);
          const spot = call?.tool === 'update_spot' ? call.target?.id : undefined;
          if (spot) set((s) => ({ agent: { ...s.agent, filled: Object.fromEntries(Object.entries(s.agent.filled).filter(([k]) => k !== spot)) } }));
        }
        await queryClient.invalidateQueries({ queryKey: ['org', orgId] });
        for (const call of at.card.drafts) if (call.tool === 'update_spot' && call.target) await get().reloadSpot(orgId, call.target.id);
        drafts(index, (d) => ({ ...d, status: 'undone' }));
      } catch (err) {
        drafts(index, (d) => ({ ...d, status: 'saved', error: toolMessage(err) }));
      }
    },

    confirmPublish: (index, confirming) => drafts(index, (d) => ({ ...d, confirming })),

    async publishDrafts(index) {
      const at = draftsAt(index);
      const orgId = orgOnScreen(router);
      if (!at || !orgId || at.drafts.status !== 'saved') return;
      drafts(index, (d) => ({ ...d, status: 'publishing', confirming: false }));
      for (const r of at.drafts.results) {
        const saved = r.ok ? savedOf(r.tool, r.output) : undefined;
        if (!saved) continue;
        if (r.tool === 'update_spot') await get().publishSpot(orgId, String(saved.id));
        else if (r.tool === 'update_playlist') await get().publishPlaylist(orgId, String(saved.id));
        else if (r.tool === 'create_schedule_entry' || r.tool === 'update_schedule_entry') await get().publishEntry(orgId, String(saved.id));
      }
      drafts(index, (d) => ({ ...d, status: 'published' }));
    },

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
        else if (event.type === 'answer') {
          const drafts = event.card.drafts.length ? { status: 'proposed' as const, summaries: [], results: [], error: null, confirming: false } : null;
          say({ role: 'assistant', card: event.card, drafts });
          if (drafts) void summarizeAt(get().agentDrawer.messages.length - 1, event.card.drafts);
        } else say({ role: 'error', text: event.message, inSettings: IN_SETTINGS.has(event.error) });
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
