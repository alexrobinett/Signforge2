/**
 * Calling a tool from the browser: `POST /api/tools/:name` on this origin, as the signed-in member
 * (the API checks the session, the role and the input). A refusal throws `ToolCallError` with the
 * tool's own message, written to be shown as it is.
 */
import type { AuditPage } from './audit';
import { ORG_CHANGED } from '@signforge/api/tab-org';
import { OrgChanged } from './org-changed';
import { tabOrgHeaders } from './tab-org';
import type { PlaylistView } from './playlists';
import type { SpotView } from './spots';

/** A tool's refusal, or a call that got no answer (`code` network). */
export class ToolCallError extends Error {
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
  const headers = { 'content-type': 'application/json', ...(await tabOrgHeaders()) };
  let res: Response;
  try {
    res = await fetch(`/api/tools/${name}`, { method: 'POST', headers, body: JSON.stringify(input) });
  } catch (cause) {
    // biome-ignore lint/style/useErrorCause: the cause is passed, in the options argument.
    throw new ToolCallError('network', 'Could not reach SignForge. Check your connection and try again.', undefined, { cause });
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const text = (key: string) => (isRecord(body) && typeof body[key] === 'string' ? body[key] : undefined);
    if (text('error') === ORG_CHANGED) throw new OrgChanged(text('message'));
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

/** The schedule entry's id in an `{ entry }` output, such as `start_takeover`'s. */
export function entryIdOf(output: unknown): string {
  if (isRecord(output) && isRecord(output.entry) && typeof output.entry.id === 'string') return output.entry.id;
  throw new ToolCallError('error', 'SignForge answered without the schedule entry. Reload the page to see it.');
}

/** The version of the screen in a `{ screen }` output, such as `rename_screen`'s: what the next edit sends as `ifVersion`. */
export function screenVersionOf(output: unknown): number {
  if (isRecord(output) && isRecord(output.screen) && typeof output.screen.version === 'number') return output.screen.version;
  throw new ToolCallError('error', 'SignForge answered without the screen. Reload the page to see it.');
}

/** The id of the kit in a `{ brandKit }` output, such as `create_brand_kit`'s. */
export function brandKitIdOf(output: unknown): string {
  if (isRecord(output) && isRecord(output.brandKit) && typeof output.brandKit.id === 'string') return output.brandKit.id;
  throw new ToolCallError('error', 'SignForge answered without the brand kit. Reload the page to see it.');
}

/** The version of the row in a `{ [of]: { version } }` output, such as `update_org_settings`' (`settings`): what the next save sends as `ifVersion`. */
export function versionOf(output: unknown, of: string): number {
  const row = isRecord(output) ? output[of] : undefined;
  if (isRecord(row) && typeof row.version === 'number') return row.version;
  throw new ToolCallError('error', 'SignForge answered without what it saved. Reload the page to see it.');
}

/** Whether a refusal is an `ifVersion` conflict: someone changed the thing since the page read it. */
export const isStale = (err: unknown) =>
  err instanceof ToolCallError && err.code === 'conflict' && isRecord(err.details) && typeof err.details.version === 'number';

/** Whether a refusal is a conflict of any kind, such as a publish made since an Undo's. */
export const isConflict = (err: unknown) => err instanceof ToolCallError && err.code === 'conflict';

/** A tool's refusal as a sentence for the page. */
export const toolMessage = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.');

/** Whether a refusal says the row is gone: deleted, by someone else or in another tab. */
export const isGone = (err: unknown) => err instanceof ToolCallError && err.code === 'not_found';

/** An editor's state after a refused save: `stale` when someone else changed the row since, which the editor offers to reload. */
export const saveRefused = (err: unknown) =>
  isStale(err) ? { stale: true, saveError: 'This changed since you opened it.' } : { stale: false, saveError: toolMessage(err) };

/** The spot in a `{ spot }` output, such as `update_spot`'s, for the Query cache. */
export function spotOf(output: unknown): SpotView {
  if (isRecord(output) && isSpot(output.spot)) return output.spot;
  throw new ToolCallError('error', 'SignForge answered without the spot. Reload the page to see it.');
}

const isSpot = (v: unknown): v is SpotView => isRecord(v) && typeof v.id === 'string' && typeof v.version === 'number' && typeof v.kind === 'string';

/** A `list_audit_log` page, as the CSV export reads it from the browser. */
export function auditPageOf(output: unknown): AuditPage {
  if (isRecord(output) && Array.isArray(output.entries) && (output.next === null || typeof output.next === 'string'))
    return { entries: output.entries, next: output.next };
  throw new ToolCallError('error', 'SignForge answered without the audit log. Try the export again.');
}

/** The playlist in a `{ playlist }` output, such as `update_playlist`'s, for the Query cache. */
export function playlistOf(output: unknown): PlaylistView {
  if (isRecord(output) && isPlaylist(output.playlist)) return output.playlist;
  throw new ToolCallError('error', 'SignForge answered without the playlist. Reload the page to see it.');
}

const isPlaylist = (v: unknown): v is PlaylistView => isRecord(v) && typeof v.id === 'string' && typeof v.version === 'number' && Array.isArray(v.spotIds);
