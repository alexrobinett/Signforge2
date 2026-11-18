/**
 * Calling a tool from the browser: `POST /api/tools/:name` on this origin, as the signed-in member
 * (the API checks the session, the role and the input). A refusal throws `ToolCallError` with the
 * tool's own message, written to be shown as it is.
 */
class ToolCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ToolCallError';
  }
}

/** A tool's answer: its output, or on a refusal `{ error, message, details }`. Read with the guards below. */
export async function callTool(name: string, input: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`/api/tools/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  } catch (cause) {
    // biome-ignore lint/style/useErrorCause: the cause is passed, in the options argument.
    throw new ToolCallError('network', 'Could not reach SignForge. Check your connection and try again.', undefined, { cause });
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const text = (key: string) => (isRecord(body) && typeof body[key] === 'string' ? body[key] : undefined);
    throw new ToolCallError(text('error') ?? 'error', text('message') ?? `Something went wrong (${res.status}).`, isRecord(body) ? body.details : undefined);
  }
  return body;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The id of the screen in a `{ screen }` output, such as `claim_screen`'s. */
export function screenIdOf(output: unknown): string {
  if (isRecord(output) && isRecord(output.screen) && typeof output.screen.id === 'string') return output.screen.id;
  throw new ToolCallError('error', 'SignForge answered without the screen. Reload the page to see it.');
}

/** The version of the screen in a `{ screen }` output, such as `rename_screen`'s: what the next edit sends as `ifVersion`. */
export function screenVersionOf(output: unknown): number {
  if (isRecord(output) && isRecord(output.screen) && typeof output.screen.version === 'number') return output.screen.version;
  throw new ToolCallError('error', 'SignForge answered without the screen. Reload the page to see it.');
}

/** Whether a refusal is an `ifVersion` conflict: someone changed the thing since the page read it. */
export const isStale = (err: unknown) =>
  err instanceof ToolCallError && err.code === 'conflict' && isRecord(err.details) && typeof err.details.version === 'number';

/** A tool's refusal as a sentence for the page. */
export const toolMessage = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.');
