/**
 * Calling a tool (`POST /api/tools/:name`) as the signed-in member: from the browser (`callTool`)
 * or from a server function (`tool` in src/server/tools.server.ts), both reading the answer here
 * (`answer`). An output is typed by the tool's own output schema (`@signforge/tools/outputs`, a
 * types-only import, so no tool code reaches the browser) and trusted: the tools' tests check
 * every output against that schema. A refusal is a `Refusal` with the code it was refused with on
 * either side, and a server function's reaches the browser as one (`refusalAdapter`).
 */
import { createSerializationAdapter } from '@tanstack/react-router';
import type { ChatProblem } from '@signforge/api/agent-chat';
import type { InlineProblem } from '@signforge/api/agent-inline';
import { ORG_CHANGED } from '@signforge/api/tab-org';
import type { ToolErrorCode, ToolName, ToolOutput } from '@signforge/tools/outputs';
import { TAB_ORG_HEADER } from '@signforge/api/tab-org';
import { tabOrgHeaders } from './tab-org';

/** The API's own refusals, made before any tool runs (apps/api/src/api/index.ts). */
type ApiRefusalCode = typeof ORG_CHANGED | 'unauthenticated' | 'no_active_organization' | 'not_a_member';

/**
 * Why a call failed: a tool's code, the API's, the agent's (`POST /api/agent/inline`, `/api/agent/chat`), `network` when no answer
 * came, or `error` for an answer that holds no refusal.
 */
type RefusalCode = ToolErrorCode | ApiRefusalCode | InlineProblem | ChatProblem | 'network' | 'error';

/** A refused call, with its code, the sentence it was refused with (written to be shown as it is), and the tool's details. */
export class Refusal extends Error {
  override name = 'Refusal';
  constructor(
    readonly code: RefusalCode,
    message: string,
    readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** The refusal a failed answer holds; `unread` is its sentence when the answer has none (a gateway's error page). */
export async function refusalOf(res: Response, unread: string): Promise<Refusal> {
  // The API's refusal: { error, message, details? } (packages/tools README).
  const body: { error?: RefusalCode; message?: string; details?: unknown } | null = await res.json().catch(() => null);
  return new Refusal(body?.error ?? 'error', body?.message ?? unread, body?.details);
}

/** A tool's answer: its output, or its refusal thrown. */
export async function answer<T>(res: Response, unread: string): Promise<T> {
  if (!res.ok) throw await refusalOf(res, unread);
  const output: T = await res.json();
  return output;
}

async function post(name: string, input: unknown, org?: string): Promise<Response> {
  // `org` names the org explicitly, in place of the tab's: a publish names the org it read and showed (#361).
  const headers = { 'content-type': 'application/json', ...(org ? { [TAB_ORG_HEADER]: org } : await tabOrgHeaders()) };
  try {
    return await fetch(`/api/tools/${name}`, { method: 'POST', headers, body: JSON.stringify(input) });
  } catch (cause) {
    // biome-ignore lint/style/useErrorCause: the cause is passed, in the options argument.
    throw new Refusal('network', 'Could not reach SignForge. Check your connection and try again.', undefined, { cause });
  }
}

/**
 * Calls a tool from the browser, naming the tab's org, or `org`: the API refuses the call unless it
 * is the session's (#129), so it never acts on an org other than the one named.
 */
export async function callTool<N extends ToolName>(name: N, input: unknown, org?: string): Promise<ToolOutput<N>> {
  const res = await post(name, input, org);
  return answer(res, `Something went wrong (${res.status}).`);
}

/** Calls a tool by a name known only as a string: the command menu's, from `GET /api/tools`, and @signforge/media's uploads, which read their own outputs. */
export async function callToolByName(name: string, input: unknown): Promise<unknown> {
  const res = await post(name, input);
  return answer(res, `Something went wrong (${res.status}).`);
}

/** So a server function's refusal reaches the browser as a `Refusal`, its code and details kept. */
export const refusalAdapter = createSerializationAdapter({
  key: 'signforge-refusal',
  test: (value): value is Refusal => value instanceof Refusal,
  toSerializable: ({ code, message, details }) => ({ code, message, details: details === undefined ? null : JSON.stringify(details) }),
  fromSerializable: ({ code, message, details }: { code: RefusalCode; message: string; details: string | null }) =>
    new Refusal(code, message, details === null ? undefined : JSON.parse(details)),
});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether a refusal is an `ifVersion` conflict: someone changed the thing since the page read it. */
export const isStale = (err: unknown) => err instanceof Refusal && err.code === 'conflict' && isRecord(err.details) && typeof err.details.version === 'number';

/** Whether a refusal is a conflict of any kind, such as a publish made since an Undo's. */
export const isConflict = (err: unknown) => err instanceof Refusal && err.code === 'conflict';

/** A spot a publish was refused for: still holding its template's sample text, at this version, in these fields (#360). */
export interface SampleSpot {
  id: string;
  name: string;
  version: number;
  fields: string[];
}

const isSampleSpot = (v: unknown): v is SampleSpot =>
  isRecord(v) &&
  typeof v.id === 'string' &&
  typeof v.name === 'string' &&
  typeof v.version === 'number' &&
  Array.isArray(v.fields) &&
  v.fields.every((f) => typeof f === 'string');

/** A person's Publish anyway, as the tools take it (`allowSample`): the spots they were shown, at those versions, those fields only. */
export const sampleAcks = (spots: readonly SampleSpot[]) => spots.map((s) => ({ spotId: s.id, version: s.version, fields: s.fields }));

/** The spots a `sample_text` refusal names (#360), or undefined for any other error. */
export function sampleTextOf(err: unknown): SampleSpot[] | undefined {
  if (!(err instanceof Refusal) || err.code !== 'sample_text' || !isRecord(err.details) || !Array.isArray(err.details.spots)) return undefined;
  return err.details.spots.filter(isSampleSpot);
}

/** Whether a refusal says the row is gone: deleted, by someone else or in another tab. */
export const isGone = (err: unknown) => err instanceof Refusal && err.code === 'not_found';

/**
 * Whether the API refused a call from a tab whose org is no longer the session's (#129): the
 * member switched org in another tab. It holds until the tab reloads, so it is never retried, and
 * the router's error page (src/components/route-error.tsx) offers Reload.
 */
export const isOrgChanged = (err: unknown): err is Refusal & { code: typeof ORG_CHANGED } => err instanceof Refusal && err.code === ORG_CHANGED;

/** A refusal as a sentence for the page. */
export const toolMessage = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.');
