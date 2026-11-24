/**
 * What `POST /api/agent/chat` takes and streams (#267, #350), shared with the CMS's drawer. The
 * drawer's `ChatClient` (`@tanstack/ai-client`) sends AG-UI's `RunAgentInput`: the question as its
 * one message, and in `forwardedProps` the page it was asked on and the conversation so far, each
 * earlier answer its card's answer. The answer streams back as server-sent events (TanStack AI's
 * `toServerSentEventsResponse`), only the run's start and end and our own `CUSTOM` events
 * (`CHAT_EVENTS`): each tool call as a card, the card's text as it is written, then the answer's
 * card; or a `RUN_ERROR` whose `code` is a `ChatProblem` and `message` says it in a sentence. Types and
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

/**
 * An earlier turn sent back: the person's words, or the agent's answer (its card's text, groups and
 * notes), never the card's trace or drafts, which the browser could forge as tools' results.
 */
export type ChatTurn = { role: 'user'; text: string } | { role: 'assistant'; card: Pick<AnswerCard, 'text' | 'groups' | 'steps'> };

/** What the drawer sends besides the question, in the run's `forwardedProps`. */
export interface ChatContext {
  /** The conversation before the question, oldest first, starting with the person's words. */
  history: ChatTurn[];
  /** Where the drawer was asked: the CMS path and the record ids in it. */
  page: { path: string; ids: Record<string, string> };
  /** On a press of a confirmation card (#269), its token: the run it paused resumes. */
  confirm?: string;
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

/**
 * The names of the `CUSTOM` events the route sends: a tool call's card (`ToolCard`), the answer's text
 * as far as it is written (`{ text }`, '' when a message turned out not to be the answer), and the
 * answer's card (`AnswerCard`), or, for a tool only a press may run, its confirmation card
 * (`ConfirmCard`, #269), the run paused for it. With `RUN_STARTED`, `RUN_FINISHED` and `RUN_ERROR`,
 * nothing else of the run reaches the browser.
 */
export const CHAT_EVENTS = {
  call: 'signforge.call',
  text: 'signforge.text',
  answer: 'signforge.answer',
  confirm: 'signforge.confirm',
  done: 'signforge.done',
} as const;

/**
 * What a press of a confirmation card did (`signforge.done`), from the action's own result, never the
 * model's word: done, or refused and why (the card is spent either way).
 */
export interface ConfirmDone {
  tool: string;
  ok: boolean;
  message: string;
}

/**
 * A tool the drawer runs only when the person presses its card (#269): publishing, a takeover, a
 * deletion, revoking, a live screen command, or reaching an address. The run pauses for it; pressed,
 * the card's `token` (one use, for this member, until `expiresAt`, bound to the input exactly as shown)
 * resumes it (`forwardedProps.confirm`), and the tool runs then, as the member, checked as they press.
 */
export interface ConfirmCard {
  /** The tool the model asked for. */
  tool: string;
  title: string;
  /** What happens, in plain words: to what, how many screens, until when. */
  lines: string[];
  /** An address it reaches, in full, and what fetches it: for an address card. */
  address: { url: string; fetches: string } | null;
  /** When it happens: now, or at the next publish. */
  when: string;
  /** How it is undone, or that it is not. */
  undo: string;
  /** The button's words. */
  press: string;
  /** Null when the member may not do this: `why` says who may. */
  token: string | null;
  why: string | null;
  expiresAt: number;
}

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
  // A confirmation card pressed twice, by someone else, after it ran out, or with other input than it showed (#269).
  'stale_card',
] as const;
export type ChatProblem = (typeof CHAT_PROBLEMS)[number];
