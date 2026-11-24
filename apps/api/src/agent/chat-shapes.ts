/**
 * What `POST /api/agent/chat` takes and streams (#267), shared with the CMS's drawer: the
 * conversation so far and the page it was asked on; then, one JSON object a line, each tool call as
 * it runs and the answer as a card, or why the turn ended. Types and limits only, so the CMS imports
 * it without the API's code or schemas; the route parses a request with its own (./chat.ts).
 */

/** The most turns of a conversation the drawer sends back: earlier ones are left out, oldest first. */
export const CHAT_HISTORY = 20;
/** The most a message may be, in characters. */
export const CHAT_MESSAGE_CHARS = 4000;

export interface ChatRequestBody {
  /** The conversation, oldest first, ending with the person's question. */
  messages: { role: 'user' | 'assistant'; text: string }[];
  /** Where the drawer was opened: the CMS path and the record ids in it. */
  page: { path: string; ids: Record<string, string> };
}

/** A group of screens the answer is about: one cause at one place, as "both Bayside screens, silent since 09:14". */
export interface AnswerGroup {
  title: string;
  screens: string[];
  why: string;
}

/** A step the answer offers. Only a note to copy: the drawer reads, and offers no step it cannot take. */
export interface AnswerStep {
  label: string;
  note: string;
}

/** One tool call of the turn, in words: "Checked 20 screens". */
export interface TraceItem {
  name: string;
  summary: string;
}

export interface AnswerCard {
  text: string;
  groups: AnswerGroup[];
  steps: AnswerStep[];
  trace: TraceItem[];
}

/** Why a turn did not run, or ended before its answer; `message` says it in a sentence. */
export type ChatProblem =
  | 'invalid_input'
  | 'no_model'
  | 'out_of_turns'
  | 'rate_limited'
  | 'over_budget'
  | 'unreadable'
  | 'unreachable'
  | 'model_refused'
  | 'busy';

/** One line of the stream. */
export type ChatEvent = { type: 'call'; item: TraceItem } | { type: 'answer'; card: AnswerCard } | { type: 'error'; error: ChatProblem; message: string };
