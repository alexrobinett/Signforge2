/**
 * Calling a tool from the browser: `POST /api/tools/:name` on this origin, as the signed-in member
 * (the API checks the session, the role and the input). A refusal throws `ToolCallError` with the
 * tool's own message, written to be shown as it is.
 */
export class ToolCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ToolCallError';
  }
}

export async function callTool<T = unknown>(name: string, input: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/tools/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  } catch {
    throw new ToolCallError('network', 'Could not reach SignForge. Check your connection and try again.');
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string; details?: unknown };
  if (!res.ok) throw new ToolCallError(body.error ?? 'error', body.message ?? `Something went wrong (${res.status}).`, body.details);
  return body as T;
}

/** A tool's refusal as a sentence for the page. */
export const toolMessage = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.');
