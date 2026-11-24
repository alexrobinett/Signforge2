/**
 * What the agent's drawer may draft (#268, docs/proposals/cms-agent.md): a few writes, each a
 * proposal in the turn and written only when the person saves it (`POST /api/agent/apply`).
 *
 * Each draft names its target and how it is read before (`DRAFTS`), so the drawer shows what it
 * would change and the person can undo it; and each is checked here, in the turn and again when it
 * is saved (`draftRefusal`), whatever the model was told:
 *  - only `content:draft` and `screens:manage` writes that change a draft, never one that publishes,
 *    takes over, deletes, revokes, reaches an address or acts on live screens at once;
 *  - no spot's `url`, kind, media or bindings, and no web page spot at all (its address is one the
 *    stage and screens open; #269's card will show it);
 *  - no takeover: an entry that cuts in at once is #269's to confirm.
 * A viewer's drawer drafts too, as a request to copy for someone who may save it: the dispatcher
 * refuses a viewer's save, as it refuses any of theirs.
 */
import { CMS_AGENT_CLIENT_ID, type Caller, dispatch, type Grant, permits, registry } from '@signforge/tools';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { ApiEnv } from '../api';
import { cmsCaller, STATUS } from '../api/tools';
import type { ConnectorDeps } from '../connectors';
import type { ApplyAnswer, ProposedCall } from './chat-shapes';

type ApplyResult = ApplyAnswer['results'][number];

type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A draft's target: the read tool that gives it as it is now, the input key naming it, and the output key holding it. */
interface Target {
  kind: string;
  read: string;
  id: string;
  out: string;
}

/** The writes the drawer drafts, and their targets; a creation has none. Each has its undo in the CMS (src/state/agent-drawer.ts). */
const DRAFTS: Record<string, Target | null> = {
  update_spot: { kind: 'spot', read: 'get_spot', id: 'spotId', out: 'spot' },
  update_playlist: { kind: 'playlist', read: 'get_playlist', id: 'playlistId', out: 'playlist' },
  update_schedule_entry: { kind: 'schedule_entry', read: 'list_schedule_entries', id: 'scheduleEntryId', out: 'entries' },
  create_schedule_entry: null,
  rename_screen: { kind: 'screen', read: 'get_screen', id: 'screenId', out: 'screen' },
};

/** At most this many drafts in a turn, and in one save: each save is a few D1 statements, inside the Free plan's 50. */
export const MAX_DRAFTS = 5;

/**
 * The drafting tools a caller with `grant` is offered: those of `DRAFTS` its role may call, or, for a
 * viewer, those an editor may, as requests to copy.
 */
export function draftTools(grant: Grant) {
  const asked = grant.role === 'viewer' ? { ...grant, role: 'editor' as const } : grant;
  return Object.keys(DRAFTS).flatMap((name) => {
    const tool = registry.get(name);
    return tool && tool.mutates && !tool.people && permits(asked, tool) ? [tool] : [];
  });
}

/** The draft's target as it is now, through its read tool, as the member; null for a creation, or why it cannot be read. */
async function before(caller: Caller, name: string, input: Row): Promise<{ target: Row | null } | { problem: string }> {
  const t = DRAFTS[name];
  if (!t) return { target: null };
  const id = input[t.id];
  const out = await dispatch(registry, t.read, t.read === 'list_schedule_entries' ? { limit: 200 } : { [t.id]: id }, caller);
  if (!out.ok) return { problem: out.message };
  const found = isRow(out.output) ? out.output[t.out] : undefined;
  const target = Array.isArray(found) ? found.find((e) => isRow(e) && e.id === id) : found;
  return isRow(target) ? { target } : { problem: `${t.kind} ${String(id)} not found` };
}

/** Why the drawer may not make this draft, whatever the role allows; undefined when it may. */
function draftRefusal(name: string, input: Row, target: Row | null): string | undefined {
  if (name === 'update_spot') {
    if (target?.kind === 'url') return "a web page spot's address is not the agent's to change: change it in the spot's editor";
    for (const key of ['url', 'kind', 'assetId', 'fit', 'bindings', 'assets'])
      if (input[key] !== undefined) return `the agent changes a spot's name, length and fields, not its ${key}`;
  }
  if (name === 'update_schedule_entry' && (target?.takeover === true || input.startsAt !== undefined || input.endsAt !== undefined))
    return 'a takeover cuts in on screens at once: start or change it yourself, on the Schedule page';
  return undefined;
}

/**
 * A call the model made to a drafting tool, as the drawer proposes it: checked against the tool's
 * input and the rules above, its target read, and its `ifVersion` the version read, so a save made
 * since refuses it rather than being overwritten. Or why not, for the model to read.
 */
export async function propose(caller: Caller, name: string, raw: unknown): Promise<{ call: ProposedCall } | { problem: string }> {
  const tool = registry.get(name);
  if (!tool || !Object.hasOwn(DRAFTS, name)) return { problem: `${name} is not a tool you may draft with` };
  const parsed = tool.input.safeParse(raw);
  if (!parsed.success || !isRow(raw)) return { problem: parsed.success ? 'the input is not an object' : z.prettifyError(parsed.error) };
  const read = await before(caller, name, raw);
  if ('problem' in read) return read;
  const refused = draftRefusal(name, raw, read.target);
  if (refused) return { problem: refused };
  const { ifVersion: _theirs, ...input } = raw;
  const version = read.target?.version;
  const t = DRAFTS[name];
  return {
    call: {
      tool: name,
      input: typeof version === 'number' ? { ...input, ifVersion: version } : { ...input, idempotencyKey: crypto.randomUUID() },
      target: t && read.target ? { kind: t.kind, id: String(read.target.id) } : null,
      before: read.target,
    },
  };
}

const applyRequest = z
  .object({
    calls: z
      .array(z.object({ tool: z.string().max(60), input: z.record(z.string(), z.unknown()) }).strict())
      .min(1)
      .max(MAX_DRAFTS),
  })
  .strict();

/**
 * `POST /api/agent/apply` (#268): the drafts the person saved, written in order through the
 * dispatcher as the member via cms-agent, each checked again as when it was proposed; the first
 * refused (a save made since, `conflict`) stops the rest, and is said as a refused call. Each write is
 * audited by the dispatcher in its batch. Budget: at most 5 drafts, at most 45 D1 statements (test).
 */
export function mountApply(api: Hono<ApiEnv>, connectors: ConnectorDeps | undefined) {
  api.post('/agent/apply', async (c) => {
    if (!/^application\/json\b/i.test(c.req.header('content-type') ?? ''))
      return c.json({ error: 'invalid_input', message: 'send the request as application/json' }, 415);
    let body: unknown;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      return c.json({ error: 'invalid_input', message: 'the body is not JSON' }, 400);
    }
    const parsed = applyRequest.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', message: z.prettifyError(parsed.error) }, 400);
    const caller: Caller = { ...cmsCaller(c, connectors), actor: { kind: 'user', id: c.var.session.user.id, clientId: CMS_AGENT_CLIENT_ID } };
    const results: ApplyResult[] = [];
    for (const { tool, input } of parsed.data.calls) {
      if (!Object.hasOwn(DRAFTS, tool)) {
        results.push({ tool, ok: false, error: 'forbidden', message: `${tool} is not one the agent drafts` });
        break;
      }
      const read = await before(caller, tool, input);
      const refused = 'problem' in read ? read.problem : draftRefusal(tool, input, read.target);
      if (refused) {
        results.push({ tool, ok: false, error: 'forbidden', message: refused });
        break;
      }
      const out = await dispatch(registry, tool, input, caller);
      if (!out.ok) {
        results.push({ tool, ok: false, error: out.error, message: out.message });
        break;
      }
      results.push({ tool, ok: true, output: out.output });
    }
    const failed = results.at(-1);
    // A refusal keeps its status (403 for a viewer, 409 for a save made since), with the results: the writes before it stand.
    return c.json({ results } satisfies ApplyAnswer, failed && !failed.ok ? STATUS[failed.error] : 200);
  });
}
