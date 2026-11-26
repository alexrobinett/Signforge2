/**
 * The agent eval's machinery (#345, README.md): a seeded org, a model (scripted, or a live one), and the
 * two arms a task runs in: /mcp through the MCP SDK's own client, and the drawer through its chat route.
 * Everything is measured from the model's side: each request it was sent and each answer it gave, so
 * both arms count tool calls, refusals and tokens the same way.
 */
import { Client as McpClient, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { testScope } from '@signforge/db/testing';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { getEncoding } from 'js-tiktoken';
import { expect, vi } from 'vitest';
import { z } from 'zod';
import { CHAT_EVENTS } from '../../src/agent/chat-shapes';
import { mcp } from '../../src/mcp';
import { Client, email, ORIGIN, testApp } from '../client';
import { anthropicStream } from '../model-streams';
import { agentToken } from '../oauth';

export type Arm = 'mcp' | 'drawer';
export type Role = 'owner' | 'editor' | 'viewer';

const o200k = getEncoding('o200k_base');

/** A tool catalogue's size as the audit of #345 counts it: `{ tools }` as compact JSON, in o200k tokens and bytes. */
function catalogueSize(tools: readonly unknown[]) {
  const json = JSON.stringify({ tools });
  return { tools: tools.length, bytes: new TextEncoder().encode(json).length, tokens: o200k.encode(json).length };
}

/**
 * The words the model is sent beside the tools: the system prompt (/mcp's server instructions and the eval's own lines,
 * or the drawer's) and, in the drawer, its first message's context around the question (the role, what it may not do)
 * and its answer's schema with its field descriptions (`output_config`, review of #566). Pinned with the catalogue, so
 * text moved out of tool descriptions into any of them is still counted (review of #470).
 */
function promptSize(system: unknown, first: unknown, output?: unknown) {
  const text = JSON.stringify([system ?? '', first ?? '', ...(output === undefined ? [] : [output])]);
  return { bytes: new TextEncoder().encode(text).length, tokens: o200k.encode(text).length };
}

// ------------------------------------------------------------------ the seeded org

/** What every task's org holds, by name: made the same way each time, through the scoped repositories and the tools. */
export interface World {
  orgId: string;
  screens: { baysideDoor: string; baysideTill: string; harbor: string; cafe: string };
  groups: { bayside: string; cafe: string };
  spots: { breakfast: string; weather: string; lunch: string };
  /** Lunch specials' version once seeded: its draft, unpublished. */
  lunchVersion: number;
  playlists: { lobby: string; breakfast: string; winter: string };
  /** Breakfast on the Bayside group, weekdays 06:00 to 10:00. */
  entry: string;
  templates: { menu: string; announcement: string; weather: string };
  /** The org's publishes once seeded: one. */
  publishes: number;
}

/** The base templates the org holds as its own, from templates/ (vitest.config.ts builds them). */
const TEMPLATES = { menu: 'menu-board', announcement: 'announcement', weather: 'weather' } as const;
/** When the Bayside screens were last heard from: a fixed morning, long before any run. */
const BAYSIDE_SEEN = Date.UTC(2026, 10, 23, 9, 14);
/** The Harbor and Cafe screens' time zone: the one the schedule tasks' entries play in. */
const LONDON = 'Europe/London';

/**
 * Seeds `owner`'s new org: four screens in two groups, three web page spots in three playlists (the Lobby loop
 * the default), a schedule entry, three templates and a publish of it all; then one change left unpublished (Lunch
 * specials to 15 seconds), so there is something to publish and an audit row to find.
 */
async function seed(owner: Client): Promise<World> {
  const org = await owner.createOrg('Harbor Grocers');
  const scope = testScope(env.DB, org.id);
  const screen = async (name: string, timezone: string, lastSeenAt: number | null) =>
    (await scope.screens.insert({ name, timezone, orientation: 'landscape', lastSeenAt })).id;
  const screens = {
    baysideDoor: await screen('Bayside door', 'America/Los_Angeles', BAYSIDE_SEEN),
    baysideTill: await screen('Bayside till', 'America/Los_Angeles', BAYSIDE_SEEN),
    harbor: await screen('Harbor lobby', LONDON, null),
    cafe: await screen('Cafe counter', LONDON, null),
  };
  const tool = async (name: string, input: Record<string, unknown>) => owner.ok<Record<string, { id: string; version: number }>>(`/api/tools/${name}`, input);
  const groups = {
    bayside: (await tool('save_group', { name: 'Bayside', screenIds: [screens.baysideDoor, screens.baysideTill] })).group!.id,
    cafe: (await tool('save_group', { name: 'Cafe', screenIds: [screens.cafe] })).group!.id,
  };
  const builds: { dir: string; manifest: { name: string; version: string } }[] = JSON.parse(env.TEMPLATE_BUILDS);
  const template = async (dir: string) => {
    const build = builds.find((b) => b.dir === dir);
    if (!build) throw new Error(`no template ${dir} in templates/`);
    const made = await scope.templates.insert({ key: dir, name: build.manifest.name });
    const version = await scope.templates.versions.insert({
      templateId: made.id,
      version: build.manifest.version,
      manifestJson: JSON.stringify(build.manifest),
      bundleSha256: 'c'.repeat(64),
      checkReportJson: JSON.stringify({ ok: true, bundleBytes: 1000, checks: [], warnings: [], checkedAt: 0, sourcesSha256: 'd'.repeat(64) }),
      status: 'approved',
    });
    return { id: made.id, versionId: version.id };
  };
  const templates = {
    menu: await template(TEMPLATES.menu),
    announcement: await template(TEMPLATES.announcement),
    weather: await template(TEMPLATES.weather),
  };
  const spot = async (name: string, path: string, durationMs: number) =>
    (await tool('save_spot', { name, kind: 'url', url: `https://example.com/${path}`, durationMs })).spot!.id;
  const spots = {
    breakfast: await spot('Breakfast menu', 'breakfast', 10_000),
    // A template spot, as most are: the drawer drafts changes to these, never to a web page spot's (its address is the person's).
    weather: (
      await tool('save_spot', {
        name: 'Weather',
        kind: 'template',
        templateVersionId: templates.announcement.versionId,
        durationMs: 8000,
        data: {
          eyebrow: 'Weather',
          headline: 'Sunny all day',
          body: 'A high of 18°C and light winds.',
          meta: 'Updated at 07:00',
          showPhoto: false,
          showQr: false,
        },
      })
    ).spot!.id,
    lunch: await spot('Lunch specials', 'lunch', 12_000),
  };
  const playlist = async (name: string, spotIds: string[]) => (await tool('save_playlist', { name, spotIds })).playlist!.id;
  const playlists = {
    lobby: await playlist('Lobby loop', [spots.breakfast, spots.weather]),
    breakfast: await playlist('Breakfast', [spots.breakfast]),
    winter: await playlist('Winter promo', [spots.lunch]),
  };
  await tool('set_default_playlist', { playlistId: playlists.lobby });
  const entry = (
    await tool('save_schedule_entry', {
      playlistId: playlists.breakfast,
      target: 'group',
      groupId: groups.bayside,
      days: [1, 2, 3, 4, 5],
      from: '06:00',
      to: '10:00',
    })
  ).entry!.id;
  await tool('publish', {});
  const lunch = (await tool('save_spot', { spotId: spots.lunch, durationMs: 15_000 })).spot!;
  return {
    orgId: org.id,
    screens,
    groups,
    spots,
    lunchVersion: lunch.version,
    playlists,
    entry,
    templates: { menu: templates.menu.id, announcement: templates.announcement.id, weather: templates.weather.id },
    publishes: (await scope.publishes.list()).length,
  };
}

// ------------------------------------------------------------------ the model

/** One model turn of a script: the tools it calls, or, when none, its answer. */
type Turn = { name: string; input: Record<string, unknown> }[];
/** A turn, or one made from the tool results the model was just sent (an id a call before it made). */
export type Step = Turn | ((results: string[]) => Turn);

/** A request to Anthropic's Messages API, and its answer, as the eval saw them. */
interface Exchange {
  body: { tools?: unknown[]; system?: unknown; messages: { role: string; content: unknown }[]; output_config?: unknown };
  answered: Promise<{ toolUses: string[]; input: number; output: number; problem?: string }>;
}

/** A usage block's input: what was billed fresh, and what was read from or written to the cache. */
interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
const inputOf = (u: Usage) => (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

/** A streamed answer's event, as far as the harness reads it. */
export interface StreamEvent {
  type: string;
  message?: { usage?: Usage };
  usage?: Usage;
  delta?: { stop_reason?: string };
  content_block?: { type: string; name?: string };
}

/** A usage block's fields that are there: a later block's missing or null field leaves an earlier one's (review of #566). */
const present = (u: Usage | undefined): Usage => Object.fromEntries(Object.entries(u ?? {}).filter(([, v]) => v !== undefined && v !== null));

/** Whether a reply ended its turn: a cut-off one (max tokens, a full context window) or a refusal did not (review of #470). */
const FINISHED = new Set(['end_turn', 'tool_use', 'stop_sequence']);

/**
 * What one streamed answer called and used, from its events. Usage is cumulative: message_delta's fields over
 * message_start's, field by field, so a delta without the cache fields keeps message_start's (review of #470). A tool
 * call the reply was cut off in is no call: a reply stopped at max_tokens whose last block is a tool use made none.
 */
export function streamed(events: readonly StreamEvent[]): { toolUses: string[]; input: number; output: number } {
  let usage: Usage = {};
  let stop: unknown;
  const blocks: { tool?: string }[] = [];
  for (const e of events) {
    if (e.type === 'message_start') usage = { ...usage, ...present(e.message?.usage) };
    if (e.type === 'message_delta') {
      usage = { ...usage, ...present(e.usage) };
      stop = e.delta?.stop_reason;
    }
    if (e.type === 'content_block_start') blocks.push(e.content_block?.type === 'tool_use' ? { tool: e.content_block.name ?? '' } : {});
  }
  if (stop === 'max_tokens' && blocks.at(-1)?.tool !== undefined) blocks.pop();
  return { toolUses: blocks.flatMap((b) => (b.tool === undefined ? [] : [b.tool])), input: inputOf(usage), output: usage.output_tokens ?? 0 };
}

/** What the model was asked and answered in one run. */
class ModelLog {
  readonly exchanges: Exchange[] = [];
  /** The conversation after the model's last answer, when the caller keeps it (the /mcp loop): its last tool results are in no request. */
  tail: Exchange['body']['messages'] = [];
  /**
   * `inner` (the model), recording each Messages request and reading each answer's tool calls and usage: from its
   * JSON, or from a copy of its stream, as the drawer reads the stream itself.
   */
  wrap(inner: typeof fetch): typeof fetch {
    return async (input, init) => {
      const request = new Request(input, init);
      if (!new URL(request.url).pathname.endsWith('/v1/messages')) return inner(input, init);
      const body: Exchange['body'] = await request.clone().json();
      const res = await inner(request);
      const [mine, theirs] = res.body ? res.body.tee() : [null, null];
      const answered = (async () => {
        if (!res.ok) return { toolUses: [], input: 0, output: 0, problem: `model_${res.status}` };
        try {
          // Read inside the try: a body that fails mid-read is the model's answer failing, not the harness (review of #470).
          const text = mine ? await new Response(mine).text() : '';
          if (!res.headers.get('content-type')?.includes('event-stream')) {
            // Read as the /mcp loop reads it: a 200 that is no finished message (no stop_reason) does not read (review of #566).
            const parsed = reply.safeParse(JSON.parse(text));
            if (!parsed.success) return { toolUses: [], input: 0, output: 0, problem: 'model_unreadable' };
            const msg = parsed.data;
            const blocks = msg.content;
            // As a stream's: a tool call the reply was cut off in is none.
            const cut = msg.stop_reason === 'max_tokens' && blocks.at(-1)?.type === 'tool_use' ? blocks.slice(0, -1) : blocks;
            return {
              toolUses: cut.flatMap((b) => (b.type === 'tool_use' && b.name ? [b.name] : [])),
              input: inputOf(msg.usage),
              output: msg.usage.output_tokens ?? 0,
            };
          }
          return streamed(text.split('\n').flatMap((line) => (line.startsWith('data: ') ? [JSON.parse(line.slice(6))] : [])));
        } catch {
          return { toolUses: [], input: 0, output: 0, problem: request.signal.aborted ? 'model_timeout' : 'model_unreadable' };
        }
      })();
      this.exchanges.push({ body, answered });
      return new Response(theirs, { status: res.status, statusText: res.statusText, headers: res.headers });
    };
  }

  /** Every tool result the model was sent, with the call it answers: each request carries the conversation so far. */
  results() {
    const named = new Map<string, string>();
    const results = new Map<string, { tool: string; ok: boolean; text: string }>();
    for (const messages of [...this.exchanges.map((e) => e.body.messages), this.tail])
      for (const m of messages)
        for (const block of Array.isArray(m.content) ? m.content : []) {
          if (block.type === 'tool_use') named.set(block.id, block.name);
          if (block.type === 'tool_result')
            results.set(block.tool_use_id, {
              tool: named.get(block.tool_use_id) ?? '',
              ok: block.is_error !== true,
              text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
            });
        }
    return [...results.values()];
  }
}

/**
 * A scripted model: the run's `steps` in order, one a request, then its answer, as Anthropic answers: streamed
 * for the drawer (its structured answer too), JSON for the eval's own /mcp loop. The drawer's answer is its
 * card; /mcp's, a sentence.
 */
function scripted(steps: Step[], arm: Arm): typeof fetch {
  let asked = 0;
  return async (input, init) => {
    const body: { model: string; messages: { content: unknown }[] } = await new Request(input, init).json();
    const last = body.messages.at(-1)?.content;
    const results = (Array.isArray(last) ? last : []).flatMap((b) => (b.type === 'tool_result' ? [String(b.content)] : []));
    const step = steps[asked++] ?? [];
    const calls = typeof step === 'function' ? step(results) : step;
    const answer = JSON.stringify({ text: 'Done.', groups: [], steps: [] });
    const blocks = calls.length
      ? calls.map((c, i) => ({ type: 'tool_use' as const, id: `toolu_${asked}_${i}`, name: c.name, input: c.input }))
      : [{ type: 'text' as const, text: arm === 'drawer' ? answer : 'Done.' }];
    const stop = calls.length ? 'tool_use' : 'end_turn';
    if (arm === 'drawer') return anthropicStream(`msg_${asked}`, body.model, blocks, stop);
    return Response.json({
      id: `msg_${asked}`,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: blocks,
      stop_reason: stop,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  };
}

/** Anthropic's Messages API itself, with `key` on each request: the eval's /mcp loop sets it as a client does; the drawer, from the org's sealed key. */
const live =
  (key: string): typeof fetch =>
  (input, init) => {
    const request = new Request(input, init);
    if (!request.headers.has('x-api-key')) request.headers.set('x-api-key', key);
    return fetch(request);
  };

// ------------------------------------------------------------------ a run

/** What a task's check reads: the org after the run, what the tools gave the model, and the drawer's drafts and card presses. */
export interface Outcome {
  arm: Arm;
  /** The day the run's check runs, YYYY-MM-DD where the Cafe's screens are: a schedule may start on it (review of #470). */
  today: string;
  world: World;
  scope: ReturnType<typeof testScope>;
  /** Each tool result the model read: its tool, whether it was a refusal, and its text. */
  results: { tool: string; ok: boolean; text: string }[];
  /** The drawer's drafted changes, from its answer's card. */
  drafts: Draft[];
  /** The drawer's confirmation cards, as shown. */
  cards: Card[];
}

export interface RunRecord {
  task: string;
  arm: Arm;
  role: Role;
  run: number;
  model: string;
  /** The check passed and the run completed: no execution error. */
  success: boolean;
  /** Whether the org or the tool results show the work done, whatever else happened. */
  checked: boolean;
  /** Why the check failed. */
  why?: string;
  toolCalls: number;
  refusedCalls: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** The tools as the model's request carried them. */
  catalogue: Size;
  /** The words beside it, in the same units (`promptSize`). */
  prompt: { bytes: number; tokens: number };
  /** /mcp's tools/list as the client received it, before it became the model's tools. */
  discovery?: Size;
  /** What went wrong running it: the model's or the route's failures, /mcp's loop out of turns, or the harness's own. */
  errors: string[];
}

export type Size = ReturnType<typeof catalogueSize>;

export interface Task {
  id: string;
  prompt: string;
  role: Role;
  /** The arms it runs in, each with the calls a model that knows the tools makes: the scripted model's turns, and the fewest calls. */
  script: Partial<Record<Arm, (w: World) => Step[]>>;
  /** In the drawer, press the confirmation card the turn stops at, as the person would. */
  press?: true;
  /** The refused calls its script makes, per arm: a card refused to the member counts as one. */
  refusals?: Partial<Record<Arm, number>>;
  /** Other scripts, run in CI: each must pass, or must fail, its check. */
  variants?: { name: string; arm: Arm; script: (w: World) => Step[]; passes: boolean }[];
  /** Why the run failed, from the org and the tool outputs, never the model's words; undefined when it passed. */
  check: (o: Outcome) => Promise<string | undefined> | string | undefined;
}

/** The most model turns the /mcp loop takes, as a client would cut a run off. */
const MCP_TURNS = 20;
/** How long a live /mcp run's model calls may take in all: under the eval's test timeout (vitest.eval.config.ts). */
const RUN_MS = 300_000;
const MAX_TOKENS = 2048;

const SYSTEM = [
  "You are an AI agent connected to SignForge's MCP server. Do what the person asks with the tools, then say in a sentence what you did.",
  'The server says:',
].join(' ');

/** The run's org, its owner and the member the task runs as. */
async function team(t: ReturnType<typeof testApp>, role: Role) {
  const owner = new Client(t);
  await owner.signIn(email('eval-owner'));
  const world = await seed(owner);
  if (role === 'owner') return { owner, member: owner, world };
  const member = new Client(t);
  await member.signIn(email(`eval-${role}`));
  const invite = await owner.ok<{ id: string }>('/api/auth/organization/invite-member', {
    email: (await member.session()).body.user.email,
    role,
    organizationId: world.orgId,
  });
  await member.ok('/api/auth/organization/accept-invitation', { invitationId: invite.id });
  await member.setActive(world.orgId);
  return { owner, member, world };
}

/** The org's model for the drawer: `model` on an Anthropic key, as an owner saves it. */
async function saveProvider(owner: Client, model: string, key: string) {
  const saved = await owner.tool('save_ai_provider', { provider: 'anthropic', apiKey: key, fastModel: model, capableModel: model });
  expect(saved.status, await saved.clone().text()).toBe(200);
}

/** The model a run asks: its id, the key the org saves for the drawer, its fetch for the seeded world, and the drawer's clock. */
export interface Model {
  /** The model id a run asks for: a scripted model answers as this one, as the drawer's adapter shapes its calls by id. */
  id: string;
  /** What the results call it. */
  label: string;
  key: string;
  /** A scripted run's fixed time: the tools' clock and the drawer's, with no model deadline. A live run keeps the real ones. */
  clock?: number;
  fetchFor: (w: World) => typeof fetch;
}

/** The model a scripted run answers as: the live eval's default (vitest.eval.config.ts). */
const SCRIPTED_AS = 'claude-haiku-5-5';

/** A test key, shaped as Anthropic's, for a scripted model that never reads it. */
const SCRIPTED_KEY = 'sk-ant-api03-EVALEVALEVALEVALEVAL-0001';

/** Every scope: the grant is capped by the member's role, as consent caps it. */
const ALL_SCOPES = ['content:read', 'content:draft', 'content:publish', 'screens:manage', 'org:manage'];

/** /mcp as a worker answers it, for the SDK's client: each request's work settled before the next. */
const worker: typeof fetch = async (input, init) => {
  const ctx = createExecutionContext();
  const res = await mcp.request(new Request(input, init), undefined, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
};

/** What an arm's run leaves for its record and its check. */
interface Ran {
  world: World;
  errors: string[];
  drafts: Draft[];
  cards: Card[];
  /** /mcp's tools/list, as the client received it. */
  discovery?: Size;
}

/** The /mcp arm: the MCP SDK's client, as the member's agent, and the eval's own loop over Anthropic's Messages API. */
async function overMcp(task: Task, model: Model, log: ModelLog): Promise<Ran> {
  const t = testApp();
  const { member, world } = await team(t, task.role);
  const { access_token } = await agentToken(t, member, world.orgId, ALL_SCOPES);
  const client = new McpClient({ name: 'signforge-eval', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { fetch: worker, requestInit: { headers: { authorization: `Bearer ${access_token}` } } }),
  );
  const { tools } = await client.listTools();
  const discovery = catalogueSize(tools);
  const defs = tools.map((x) => ({ name: x.name, description: x.description ?? '', input_schema: x.inputSchema }));
  const system = `${SYSTEM}\n${client.getInstructions() ?? ''}`;
  const ask = log.wrap(model.fetchFor(world));
  const messages: { role: 'user' | 'assistant'; content: unknown }[] = [{ role: 'user', content: task.prompt }];
  const errors: string[] = [];
  // A live run's model calls end by RUN_MS together, so a hung call is a recorded failure, not a test timeout. A scripted run has no deadline.
  const deadline = model.clock === undefined ? AbortSignal.timeout(RUN_MS) : undefined;
  // Closed however the loop ends, a reply that does not read included (review of #470).
  try {
    for (let turn = 0; ; turn++) {
      if (turn === MCP_TURNS) {
        errors.push('out_of_turns');
        break;
      }
      let res: Response;
      try {
        res = await ask('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: model.id, max_tokens: MAX_TOKENS, system, tools: defs, messages }),
          ...(deadline ? { signal: deadline } : {}),
        });
      } catch {
        errors.push(deadline?.aborted ? 'model_timeout' : 'model_unreachable');
        break;
      }
      // The answer's own failure (its status, or a body that does not read) is recorded with its exchange.
      if (!res.ok) break;
      // One that does not read, or reads as no message ({} or an error object), is recorded with its exchange.
      const msg = reply.safeParse(await res.json().catch(() => undefined));
      if (!msg.success) break;
      const { content, stop_reason: stop } = msg.data;
      // A reply cut off (max tokens, a full context window) or refused is no finished turn, whatever its tools showed.
      if (!FINISHED.has(stop)) {
        errors.push(`model_${stop}`);
        break;
      }
      messages.push({ role: 'assistant', content });
      const uses = content.filter((b) => b.type === 'tool_use');
      if (!uses.length) break;
      const results = [];
      for (const use of uses) {
        try {
          const result = await client.callTool({ name: use.name ?? '', arguments: use.input ?? {} });
          const text = result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');
          results.push({ type: 'tool_result', tool_use_id: use.id, content: text, ...(result.isError ? { is_error: true } : {}) });
        } catch (err) {
          // A JSON-RPC error, not a tool's refusal: the client tells the model the call failed.
          errors.push('mcp_error');
          results.push({ type: 'tool_result', tool_use_id: use.id, content: String(err), is_error: true });
        }
      }
      messages.push({ role: 'user', content: results });
    }
  } finally {
    await client.close();
  }
  log.tail = messages;
  return { world, discovery, errors, drafts: [], cards: [] };
}

/** A reply's message, as the /mcp loop and the exchange both read it: else the exchange records it as model_unreadable. */
const reply = z.object({
  content: z.array(z.object({ type: z.string(), id: z.string().optional(), name: z.string().optional(), input: z.record(z.string(), z.unknown()).optional() })),
  stop_reason: z.string(),
  usage: z.object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
  }),
});

/** What a check reads of the drawer's answer card: the changes it drafted. */
const draft = z.object({ tool: z.string(), input: z.record(z.string(), z.unknown()), target: z.object({ kind: z.string(), id: z.string() }).nullable() });
type Draft = z.infer<typeof draft>;
/** What a check reads of a confirmation card: its tool, its token (null when refused) and why it was refused. */
const card = z.object({ tool: z.string(), token: z.string().nullable(), why: z.string().nullable() });
type Card = z.infer<typeof card>;

/** The drawer's events this harness reads, parsed as they arrive; the rest are skipped. */
const event = z.union([
  z.object({ type: z.literal('RUN_ERROR'), code: z.string() }),
  z.object({ type: z.literal('CUSTOM'), name: z.literal(CHAT_EVENTS.confirm), value: card }),
  z.object({ type: z.literal('CUSTOM'), name: z.literal(CHAT_EVENTS.answer), value: z.object({ drafts: z.array(draft) }) }),
]);

/** A drawer turn's server-sent events that this harness reads. */
const eventsOf = async (res: Response) =>
  (await res.text())
    .split('\n\n')
    .filter((e) => e.startsWith('data: '))
    .flatMap((e) => {
      const parsed = event.safeParse(JSON.parse(e.slice('data: '.length)));
      return parsed.success ? [parsed.data] : [];
    });

/** A turn as the drawer's ChatClient asks it; `confirm` presses a card. */
const turnBody = (text: string, confirm?: string) => ({
  threadId: 'eval',
  runId: crypto.randomUUID(),
  state: {},
  messages: [{ id: 'm1', role: 'user', content: text }],
  tools: [],
  context: [],
  forwardedProps: { history: [], page: { path: '/', ids: {} }, ...(confirm ? { confirm } : {}) },
});

/** Where a drawer turn's other fetches go (an address card's DNS and reads): nowhere. */
const NO_REACH = { fetch: async () => new Response('no', { status: 404 }), resolve: async () => ['93.184.215.14'] };
/** A scripted run's model deadline: never, so a slow machine never times a call out. */
const NO_DEADLINE = () => new AbortController().signal;

/** The drawer arm: its chat route as the member, the org's model being `model`; a card the turn stops at pressed when the task says so. */
async function inDrawer(task: Task, model: Model, log: ModelLog): Promise<Ran> {
  // The model is the world's: a scripted one names its rows, which exist only once the org is seeded.
  let inner: typeof fetch = () => Promise.reject(new Error('the model was asked before the org was seeded'));
  const { clock } = model;
  const reach = { fetch: log.wrap((input, init) => inner(input, init)), guards: clock === undefined ? NO_REACH : { ...NO_REACH, deadline: NO_DEADLINE } };
  const t = testApp({ agent: { reach, ...(clock === undefined ? {} : { now: () => clock }) } });
  const { owner, member, world } = await team(t, task.role);
  inner = model.fetchFor(world);
  await saveProvider(owner, model.id, model.key);
  const errors: string[] = [];
  const cards: Card[] = [];
  let drafts: Draft[] = [];
  const read = (all: Awaited<ReturnType<typeof eventsOf>>) => {
    for (const e of all) {
      if (e.type === 'RUN_ERROR') errors.push(e.code);
      else if (e.name === CHAT_EVENTS.confirm) cards.push(e.value);
      else drafts = e.value.drafts;
    }
  };
  const asked = await member.post('/api/agent/chat', turnBody(task.prompt));
  if (asked.status !== 200) errors.push(`http_${asked.status}`);
  else read(await eventsOf(asked));
  const token = cards.at(-1)?.token;
  if (task.press && token) {
    const pressed = await member.post('/api/agent/chat', turnBody(task.prompt, token));
    if (pressed.status !== 200) errors.push(`http_${pressed.status}`);
    else read(await eventsOf(pressed));
  }
  await member.settled();
  return { world, errors, drafts, cards };
}

/**
 * Runs `task` in `arm` once with `model`, and checks it; every attempt gives a record, one the harness itself failed
 * included. A tool call is one the model asked for: the drawer's card pause counts once, its press does not again. A
 * refused call is a tool result marked as an error, or a card refused to the member. It succeeds only when the check
 * passes and the run completed.
 */
export async function runTask(task: Task, arm: Arm, model: Model, runNo = 1, script?: (w: World) => Step[]): Promise<RunRecord> {
  const log = new ModelLog();
  const base = { task: task.id, arm, role: task.role, run: runNo, model: model.label };
  const chosen: Model = script ? { ...model, fetchFor: (w) => scripted(script(w), arm) } : model;
  if (model.clock !== undefined) vi.setSystemTime(model.clock);
  try {
    const ran = arm === 'mcp' ? await overMcp(task, chosen, log) : await inDrawer(task, chosen, log);
    const answers = await Promise.all(log.exchanges.map((e) => e.answered));
    const results = log.results();
    const outcome: Outcome = {
      arm,
      // Where the entries play, not UTC: a live run near midnight would otherwise refuse a start date already today there.
      today: new Intl.DateTimeFormat('en-CA', { timeZone: LONDON }).format(new Date()),
      world: ran.world,
      scope: testScope(env.DB, ran.world.orgId),
      results,
      drafts: ran.drafts,
      cards: ran.cards,
    };
    const why = await task.check(outcome);
    const errors = [...answers.flatMap((a) => (a.problem ? [a.problem] : [])), ...ran.errors];
    return {
      ...base,
      success: why === undefined && errors.length === 0,
      checked: why === undefined,
      ...(why === undefined ? {} : { why }),
      toolCalls: answers.reduce((n, a) => n + a.toolUses.length, 0),
      refusedCalls: results.filter((r) => !r.ok).length + ran.cards.filter((c) => c.why !== null).length,
      modelCalls: log.exchanges.length,
      inputTokens: answers.reduce((n, a) => n + a.input, 0),
      outputTokens: answers.reduce((n, a) => n + a.output, 0),
      catalogue: catalogueSize(log.exchanges[0]?.body.tools ?? []),
      prompt: promptSize(
        log.exchanges[0]?.body.system,
        arm === 'drawer' ? log.exchanges[0]?.body.messages[0]?.content : undefined,
        arm === 'drawer' ? log.exchanges[0]?.body.output_config : undefined,
      ),
      ...(ran.discovery ? { discovery: ran.discovery } : {}),
      errors,
    };
  } catch (err) {
    const none = catalogueSize([]);
    return {
      ...base,
      success: false,
      checked: false,
      why: 'the harness failed',
      toolCalls: 0,
      refusedCalls: 0,
      modelCalls: log.exchanges.length,
      inputTokens: 0,
      outputTokens: 0,
      catalogue: none,
      prompt: promptSize(undefined, undefined),
      errors: [`harness: ${err instanceof Error ? err.message : String(err)}`],
    };
  } finally {
    if (model.clock !== undefined) vi.useRealTimers();
  }
}

/** The scripted model for `task` in `arm`: its script's turns, then its answer, at `clock`. */
export function scriptedModel(task: Task, arm: Arm, clock: number): Model {
  const turns = task.script[arm];
  if (!turns) throw new Error(`${task.id} does not run in ${arm}`);
  return { id: SCRIPTED_AS, label: 'scripted', key: SCRIPTED_KEY, clock, fetchFor: (w) => scripted(turns(w), arm) };
}

/** A live model on Anthropic's API with `key`, on the real clock: a turn's time budget and the model deadline are the drawer's own. */
export const liveModel = (id: string, key: string): Model => ({ id, label: id, key, fetchFor: () => live(key) });
