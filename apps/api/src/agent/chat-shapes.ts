/**
 * What `POST /api/agent/chat` takes and streams (#267, #350), shared with the CMS's drawer. The
 * drawer's `ChatClient` (`@tanstack/ai-client`) sends AG-UI's `RunAgentInput`: the question as its
 * one message, and in `forwardedProps` the page it was asked on and the conversation so far, each
 * earlier answer its whole card. The answer streams back as server-sent events (TanStack AI's
 * `toServerSentEventsResponse`): the card's text as it is written (`structured-output.*`), and the
 * events below, `CUSTOM` ones named `CHAT_EVENTS`: each tool call as a card, then the answer's card;
 * or a `RUN_ERROR` whose `code` is a `ChatProblem` and `message` says it in a sentence. Types and
 * limits only, so the CMS imports it without the API's code or schemas; the route parses a request
 * with its own (./chat.ts).
 */
import type { ToolErrorCode } from '@signforge/tools/outputs';

/** The most turns of a conversation the drawer sends back: earlier ones are left out, oldest first. */
export const CHAT_HISTORY = 20;
/** The most a question may be, in characters. */
export const CHAT_MESSAGE_CHARS = 4000;
/** The most the conversation sent back may be, as JSON, in characters. */
export const CHAT_HISTORY_CHARS = 100_000;

/** An earlier turn sent back: the person's words, or the agent's whole card. */
export type ChatTurn = { role: 'user'; text: string } | { role: 'assistant'; card: AnswerCard };

/** What the drawer sends besides the question, in the run's `forwardedProps`. */
export interface ChatContext {
  /** The conversation before the question, oldest first, starting with the person's words. */
  history: ChatTurn[];
  /** Where the drawer was asked: the CMS path and the record ids in it. */
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

/** One tool call of the turn, as its card: the tool, its title ("Screen status"), and what it did ("Checked 20 screens"). */
export interface ToolCard {
  tool: string;
  title: string;
  summary: string;
  ok: boolean;
}

/**
 * A change the drawer proposes (#268): the tool and its input as the person would save it (with the
 * `ifVersion` read, so a save made since refuses it), its target, and the target as it was read, for
 * the change summary and Undo. Nothing is written until the person saves it (`POST /api/agent/apply`).
 */
export interface ProposedCall {
  tool: string;
  input: Record<string, unknown>;
  target: { kind: string; id: string } | null;
  before: Record<string, unknown> | null;
}

export interface AnswerCard {
  text: string;
  groups: AnswerGroup[];
  steps: AnswerStep[];
  /** The turn's tool calls, in order. */
  trace: ToolCard[];
  /** The changes proposed, in order: none for a question that changes nothing. */
  drafts: ProposedCall[];
}

/** The names of the `CUSTOM` events the route adds to the stream. */
export const CHAT_EVENTS = { call: 'signforge.call', answer: 'signforge.answer' } as const;

/** What a save of the drafts did: each written in order, the first refused stopping the rest. */
export interface ApplyAnswer {
  results: ({ tool: string; ok: true; output: unknown } | { tool: string; ok: false; error: ToolErrorCode; message: string })[];
}

/** Why a turn did not run, or ended before its answer; `message` says it in a sentence. */
export const CHAT_PROBLEMS = [
  'invalid_input',
  'no_model',
  'out_of_turns',
  'rate_limited',
  'over_budget',
  'unreadable',
  'unreachable',
  'model_refused',
  'busy',
] as const;
export type ChatProblem = (typeof CHAT_PROBLEMS)[number];
