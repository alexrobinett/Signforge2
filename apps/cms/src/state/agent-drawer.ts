/**
 * The agent's drawer (#267, #350, docs/proposals/cms-agent.md): open or not, the conversation, and
 * the turn on its way, which is asked with the page shown when it is asked. A turn is TanStack AI's
 * `ChatClient` (`@tanstack/ai-client`), driven from here rather than by `useChat`, so the drawer keeps
 * the CMS's state rules: it posts to `POST /api/agent/chat` and reads its server-sent events, the
 * API's own (`CHAT_EVENTS`): each tool call's card as it runs, the card's text as it is written (read
 * by the API from the answer alone), then the answer's card, or why it ended. Text shown of a turn
 * that then fails is dropped: only a whole card is kept. The cards are the drawer's own, kept here, never rebuilt from the client's messages (a pause would turn them back to
 * raw JSON, #346). The conversation lives only here, so a reload forgets it; each question sends it
 * back, the last `CHAT_HISTORY` turns of it, each answer its card's text, groups and notes.
 *
 * An answer may hold drafts (#268): changes the agent proposes, written only when the person saves
 * them (`POST /api/agent/apply`). Their summary and reach are worked out here, from the pages' own
 * reads (src/lib/draft-summary.ts), and nothing is saved until each draft has its summary: a read
 * that fails, or a change the card cannot show, leaves them unsaved until worked out again. Saved, a
 * spot's changed fields are marked in its editor, as the agent's update marks them (#264); Undo these
 * changes puts each back as it was, as the person, the last first, each at the version its target is
 * at now; one that fails stops the rest, and Undo again carries on from it.
 */
import {
  type AnswerCard,
  type ApplyAnswer,
  CHAT_EVENTS,
  CHAT_HISTORY,
  CHAT_HISTORY_CHARS,
  CHAT_PROBLEMS,
  type ChatContext,
  type ChatTurn,
  type ProposedCall,
  type ToolCard,
} from '@signforge/api/agent-chat';
import { ChatClient, fetchServerSentEvents } from '@tanstack/ai-client';
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

/** What an answer's drafts do: being worked out, one summary a draft, or why not, so they cannot be saved yet. */
type Shown = { state: 'working' } | { state: 'shown'; summaries: DraftSummary[] } | { state: 'failed'; reason: string };

/** An answer's drafts: proposed, saving, saved (or refused at the first that was), then undone or published. */
interface Drafts {
  status: 'proposed' | 'saving' | 'saved' | 'refused' | 'undoing' | 'undone' | 'publishing' | 'published';
  shown: Shown;
  /** What the save wrote, in order: the last refused, when one was. */
  results: ApplyAnswer['results'];
  /** The saved drafts Undo has put back, by their place in `results`: Undo again skips them. */
  undone: number[];
  /** Each saved target's version now, by its id, as the last save or undo left it: what the next undo of it is made at. */
  versions: Record<string, number>;
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
  /** The turn's tool calls so far, each its card. */
  progress: ToolCard[];
  /** The answer's text as far as it has streamed: dropped if the turn fails. */
  streaming: string;
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
  /** Works out again what the drafts of the answer at `index` do, after it failed. */
  showDrafts: (index: number) => Promise<void>;
  /** Saves the drafts of the answer at `index` (#268), once each has its summary. */
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
 * The call that puts a saved draft back, at `version`, its target's now: a creation deleted, unless
 * edited since; a schedule entry given back all it was, so whom it is aimed at goes back too (from a
 * group to everywhere, or back); another update given back each value it changed, as the draft read it.
 */
function undoOf(call: ProposedCall, saved: Row, version: number | undefined): { tool: string; input: Row } {
  const id = TARGETS[call.tool]?.id ?? '';
  const before = call.before ?? {};
  if (call.tool === 'create_schedule_entry') return { tool: 'delete_schedule_entry', input: { scheduleEntryId: saved.id, ifVersion: version } };
  if (call.tool === 'update_schedule_entry')
    return {
      tool: call.tool,
      input: {
        scheduleEntryId: saved.id,
        playlistId: before.playlistId,
        target: before.target,
        ...(before.target === 'group' ? { groupId: before.groupId } : before.target === 'screen' ? { screenId: before.screenId } : {}),
        priority: before.priority,
        ...Object.fromEntries(['days', 'from', 'to', 'startDate', 'endDate'].map((k) => [k, before[k] ?? null])),
        ifVersion: version,
      },
    };
  const keys = Object.keys(call.input).filter((k) => k !== id && k !== 'ifVersion');
  return { tool: call.tool, input: { [id]: saved.id, ...Object.fromEntries(keys.map((k) => [k, before[k] ?? null])), ifVersion: version } };
}

/** A version a tool gave back, of its record or, for a deletion, at top level. */
const versionOf = (tool: string, output: unknown): number | undefined => {
  const v = savedOf(tool, output)?.version ?? (isRow(output) ? output.version : undefined);
  return typeof v === 'number' ? v : undefined;
};

const IN_SETTINGS = new Set(['no_model', 'model_refused']);

/** The record ids in the page's path, as its route names them: what "this screen" means. */
const idsOf = (params: unknown): Record<string, string> =>
  typeof params === 'object' && params !== null
    ? Object.fromEntries(Object.entries(params).filter((e): e is [string, string] => typeof e[1] === 'string'))
    : {};

const closed = (): AgentDrawerState => ({ open: false, messages: [], question: '', asking: false, progress: [], streaming: '', opener: null });

/**
 * The conversation sent back with a question: the person's words and each answer's card, its text,
 * groups and notes (never its trace or drafts, which the API does not take back as the tools'), the
 * last `CHAT_HISTORY` turns within `CHAT_HISTORY_CHARS`, the oldest left out first, starting with the
 * person's words. A turn that gave no answer is left out.
 */
function historyOf(messages: readonly DrawerMessage[]): ChatTurn[] {
  let turns = messages
    .flatMap((m): ChatTurn[] =>
      m.role === 'user'
        ? [{ role: 'user', text: m.text }]
        : m.role === 'assistant'
          ? [{ role: 'assistant', card: { text: m.card.text, groups: m.card.groups, steps: m.card.steps } }]
          : [],
    )
    .slice(-CHAT_HISTORY);
  while (turns[0] && (turns[0].role === 'assistant' || JSON.stringify(turns).length > CHAT_HISTORY_CHARS)) turns = turns.slice(1);
  return turns;
}

/** A fetch that says a refused request in the API's own words (`no_model`, `rate_limited`…), as a `Refusal`. */
const said: typeof fetch = async (input, init) => {
  const res = await fetch(input, init).catch((cause: unknown) => {
    throw new Refusal('network', 'Could not reach SignForge. Check your connection and try again.', undefined, { cause });
  });
  if (!res.ok) throw await refusalOf(res, `Something went wrong (${res.status}).`);
  return res;
};

export const createAgentDrawerSlice: SliceCreator<AgentDrawerSlice> = (set, get, { router, queryClient }) => {
  const drawer = (change: (d: AgentDrawerState) => AgentDrawerState) => set((s) => ({ agentDrawer: change(s.agentDrawer) }));
  /** The turn on its way: forgetting the drawer stops it, and what it would still say is dropped. */
  let running: ChatClient | null = null;
  /** The conversation's thread, for every turn of it; a new one once forgotten. */
  let thread: string | null = null;
  /** Which conversation this is: forgetting the drawer starts the next, and what the last one was doing changes nothing. */
  let conversation = 0;

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

  /**
   * The drafts' summaries and reach, from the pages' own reads of the org. Each draft needs one
   * before any is saved: a read that fails, or a change one cannot show, says why instead.
   */
  async function summarizeAt(index: number) {
    const at = draftsAt(index);
    const orgId = orgOnScreen(router);
    if (!at || !orgId) return;
    const calls = at.card.drafts;
    // Only this conversation's: a drawer forgotten meanwhile (the org switched) holds another, or none.
    const asked = conversation;
    const write = (change: (d: Drafts) => Drafts) => {
      if (conversation === asked) drafts(index, change);
    };
    write((d) => ({ ...d, shown: { state: 'working' } }));
    try {
      const [fleet, schedule, playlists, spots, templates] = await Promise.all([
        queryClient.query(screensQuery(orgId)),
        queryClient.query(scheduleQuery(orgId)),
        queryClient.query(playlistsQuery(orgId)),
        queryClient.query(spotsQuery(orgId)),
        queryClient.query(templatesQuery(orgId)),
      ]);
      let versions = versionsById(templates.templates);
      // A spot on a template version added since the templates were read: read them again.
      const wanted = calls.flatMap((c) => (c.tool === 'update_spot' && typeof c.before?.templateVersionId === 'string' ? [c.before.templateVersionId] : []));
      if (wanted.some((id) => !versions.has(id))) versions = versionsById((await queryClient.query({ ...templatesQuery(orgId), staleTime: 0 })).templates);
      const context = {
        screens: fleet.screens,
        groups: fleet.groups,
        entries: schedule.entries,
        playlists: playlists.playlists,
        spots: spots.spots,
        fieldsOf: (id: string) => versions.get(id)?.manifest.fields,
        at: new Date(),
      };
      const summaries = calls.map((call) => summarize(call, context));
      const problem = summaries.find((s) => 'problem' in s);
      const shown = summaries.filter((s) => 'lines' in s);
      write((d) => ({ ...d, shown: problem ? { state: 'failed', reason: problem.problem } : { state: 'shown', summaries: shown } }));
    } catch {
      write((d) => ({ ...d, shown: { state: 'failed', reason: 'Could not read your screens, schedule and content to show what the changes do.' } }));
    }
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

    showDrafts: summarizeAt,

    async saveDrafts(index) {
      const at = draftsAt(index);
      const orgId = orgOnScreen(router);
      // Not before the card shows every change it would write.
      const { shown } = at?.drafts ?? {};
      if (!at || !orgId || at.drafts.status !== 'proposed' || shown?.state !== 'shown' || shown.summaries.length !== at.card.drafts.length) return;
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
        // The version each save left, the last of a target's: what Undo puts it back at.
        const versions: Record<string, number> = {};
        for (const r of answer.results) {
          const saved = r.ok ? savedOf(r.tool, r.output) : undefined;
          if (saved && typeof saved.version === 'number') versions[String(saved.id)] = saved.version;
        }
        drafts(index, (d) => ({
          ...d,
          results: answer.results,
          versions,
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
      const was = at?.drafts.status;
      if (!at || !orgId || (was !== 'saved' && was !== 'refused')) return;
      drafts(index, (d) => ({ ...d, status: 'undoing', error: null }));
      let { undone, versions } = at.drafts;
      try {
        // The last saved first: what each put back is what it found. One put back already, by an Undo that stopped, is skipped.
        for (const [i, r] of [...at.drafts.results.entries()].reverse()) {
          if (undone.includes(i)) continue;
          const call = at.card.drafts[i];
          const saved = r.ok ? savedOf(r.tool, r.output) : undefined;
          if (call && saved) {
            const id = String(saved.id);
            const undo = undoOf(call, saved, versions[id]);
            const now = versionOf(undo.tool, await callToolByName(undo.tool, undo.input));
            if (now !== undefined) versions = { ...versions, [id]: now };
          }
          undone = [...undone, i];
          drafts(index, (d) => ({ ...d, undone, versions }));
          const spot = call?.tool === 'update_spot' ? call.target?.id : undefined;
          if (spot) set((s) => ({ agent: { ...s.agent, filled: Object.fromEntries(Object.entries(s.agent.filled).filter(([k]) => k !== spot)) } }));
        }
        drafts(index, (d) => ({ ...d, status: 'undone' }));
      } catch (err) {
        drafts(index, (d) => ({ ...d, status: was, error: toolMessage(err) }));
      }
      await queryClient.invalidateQueries({ queryKey: ['org', orgId] });
      for (const call of at.card.drafts) if (call.tool === 'update_spot' && call.target) await get().reloadSpot(orgId, call.target.id);
    },

    confirmPublish: (index, confirming) => drafts(index, (d) => ({ ...d, confirming })),

    async publishDrafts(index) {
      const at = draftsAt(index);
      const orgId = orgOnScreen(router);
      if (!at || !orgId || at.drafts.status !== 'saved') return;
      drafts(index, (d) => ({ ...d, status: 'publishing', confirming: false, error: null }));
      for (const r of at.drafts.results) {
        const saved = r.ok ? savedOf(r.tool, r.output) : undefined;
        if (!saved) continue;
        const id = String(saved.id);
        const published =
          r.tool === 'update_spot'
            ? await get().publishSpot(orgId, id)
            : r.tool === 'update_playlist'
              ? await get().publishPlaylist(orgId, id)
              : r.tool === 'create_schedule_entry' || r.tool === 'update_schedule_entry'
                ? await get().publishEntry(orgId, id)
                : true;
        // Not published (Edit first on sample text, #360, or a refusal the toast told): the drafts stay saved, and the card says so.
        if (!published) {
          drafts(index, (d) => ({ ...d, status: 'saved', error: 'Not published: the changes are saved as drafts.' }));
          return;
        }
      }
      drafts(index, (d) => ({ ...d, status: 'published' }));
    },

    openAgentDrawer(opener) {
      drawer((d) => ({ ...d, open: true, opener }));
      get().setRightPanel(true);
    },

    forgetAgentDrawer() {
      // Stopped: its request aborted, so the API stops the turn too (#335).
      running?.stop();
      running = null;
      thread = null;
      conversation++;
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
      const page: ChatContext['page'] = { path: router.state.location.pathname, ids: idsOf(router.state.matches.at(-1)?.params) };
      const question = (asked ?? typed).trim();
      if (!question || busy) return;
      const context: ChatContext = { history: historyOf(messages), page };
      drawer((d) => ({
        ...d,
        messages: [...d.messages, { role: 'user', text: question }],
        question: asked ? d.question : '',
        asking: true,
        progress: [],
        streaming: '',
      }));
      thread ??= crypto.randomUUID();
      let card: AnswerCard | undefined;
      let ended: { code: string | undefined; message: string } | undefined;
      let failure: Error | undefined;
      const turn: ChatClient = new ChatClient({
        threadId: thread,
        // Its `connect` alone: the API keeps no run to join again or read back, so a stream that breaks off ends the turn.
        connection: { connect: fetchServerSentEvents('/api/agent/chat', async () => ({ headers: await tabOrgHeaders(), fetchClient: said })).connect },
        onChunk: (chunk) => {
          if (chunk.type === 'CUSTOM' && chunk.name === CHAT_EVENTS.call) {
            const shown: ToolCard = chunk.value;
            mine((d) => ({ ...d, progress: [...d.progress, shown] }));
          } else if (chunk.type === 'CUSTOM' && chunk.name === CHAT_EVENTS.text) {
            // The card's text as far as it is written, which the API reads from the answer alone ('' takes it back).
            const text: string = chunk.value.text;
            mine((d) => ({ ...d, streaming: text }));
          } else if (chunk.type === 'CUSTOM' && chunk.name === CHAT_EVENTS.answer) card = chunk.value;
          else if (chunk.type === 'RUN_ERROR') ended = { code: chunk.code, message: chunk.message };
        },
        onError: (err) => {
          // Our refusal, as the client wraps a failed read (`StreamReadError`): the API's words, not the client's.
          let cause: unknown = err;
          while (cause instanceof Error && !(cause instanceof Refusal)) cause = cause.cause;
          failure = cause instanceof Refusal ? cause : err;
        },
      });
      running = turn;
      // Only this turn's, while it is the drawer's: once forgotten, it changes nothing.
      function mine(change: (d: AgentDrawerState) => AgentDrawerState) {
        if (running === turn) drawer(change);
      }
      const say = (message: DrawerMessage) => mine((d) => ({ ...d, messages: [...d.messages, message] }));
      await turn.sendMessage(question, context);
      if (running !== turn) return turn.dispose();
      // What streamed goes: the answer is its whole card, or there is none.
      mine((d) => ({ ...d, streaming: '' }));
      if (card) {
        const drafts: Drafts | null = card.drafts.length
          ? { status: 'proposed', shown: { state: 'working' }, results: [], undone: [], versions: {}, error: null, confirming: false }
          : null;
        say({ role: 'assistant', card, drafts });
        // The turn ends once its drafts are worked out.
        if (drafts) await summarizeAt(get().agentDrawer.messages.length - 1);
      } else if (failure instanceof Refusal) say({ role: 'error', text: toolMessage(failure), inSettings: IN_SETTINGS.has(failure.code) });
      // Why the API ended it, in its words; the client ends a stream that broke off as one too, in its own, which are not said.
      else if (ended && CHAT_PROBLEMS.some((p) => p === ended?.code))
        say({ role: 'error', text: ended.message, inSettings: IN_SETTINGS.has(ended.code ?? '') });
      else say({ role: 'error', text: 'The answer was cut off. Check your connection and ask again.', inSettings: false });
      mine((d) => ({ ...d, asking: false, progress: [] }));
      // Only while it is still the drawer's turn: one forgotten while its drafts were worked out leaves the next turn be (review of #402).
      if (running === turn) running = null;
      turn.dispose();
    },
  };
};
