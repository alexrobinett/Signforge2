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
import { expect } from 'vitest';
import { type AnswerCard, CHAT_EVENTS, type ConfirmCard, type ProposedCall } from '../../src/agent/chat-shapes';
import { mcp } from '../../src/mcp';
import { Client, email, ORIGIN, testApp } from '../client';
import { anthropicStream } from '../model-streams';
import { agentToken } from '../oauth';

export type Arm = 'mcp' | 'drawer';
export type Role = 'owner' | 'editor' | 'viewer';

const o200k = getEncoding('o200k_base');

/**
 * A tool catalogue's size as the audit of #345 counts it: `{ tools }` as compact JSON, in o200k tokens and
 * bytes. /mcp's in its own shape (`tools/list`), the drawer's in Anthropic's (`name`, `description`, `input_schema`).
 */
function catalogueSize(tools: readonly unknown[]) {
  const json = JSON.stringify({ tools });
  return { tools: tools.length, bytes: new TextEncoder().encode(json).length, tokens: o200k.encode(json).length };
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
    harbor: await screen('Harbor lobby', 'Europe/London', null),
    cafe: await screen('Cafe counter', 'Europe/London', null),
  };
  const tool = async (name: string, input: Record<string, unknown>) => owner.ok<Record<string, { id: string; version: number }>>(`/api/tools/${name}`, input);
  const groups = {
    bayside: (await tool('create_group', { name: 'Bayside', screenIds: [screens.baysideDoor, screens.baysideTill] })).group!.id,
    cafe: (await tool('create_group', { name: 'Cafe', screenIds: [screens.cafe] })).group!.id,
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
    (await tool('create_spot', { name, kind: 'url', url: `https://example.com/${path}`, durationMs })).spot!.id;
  const spots = {
    breakfast: await spot('Breakfast menu', 'breakfast', 10_000),
    // A template spot, as most are: the drawer drafts changes to these, never to a web page spot's (its address is the person's).
    weather: (
      await tool('create_spot', {
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
  const playlist = async (name: string, spotIds: string[]) => (await tool('create_playlist', { name, spotIds })).playlist!.id;
  const playlists = {
    lobby: await playlist('Lobby loop', [spots.breakfast, spots.weather]),
    breakfast: await playlist('Breakfast', [spots.breakfast]),
    winter: await playlist('Winter promo', [spots.lunch]),
  };
  await tool('set_default_playlist', { playlistId: playlists.lobby });
  const entry = (
    await tool('create_schedule_entry', {
      playlistId: playlists.breakfast,
      target: 'group',
      groupId: groups.bayside,
      days: [1, 2, 3, 4, 5],
      from: '06:00',
      to: '10:00',
    })
  ).entry!.id;
  await tool('publish', {});
  const lunch = (await tool('update_spot', { spotId: spots.lunch, durationMs: 15_000 })).spot!;
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
  body: { tools?: { name: string; description?: string; input_schema: unknown }[]; messages: { role: string; content: unknown }[] };
  answered: Promise<{ toolUses: string[]; input: number; output: number }>;
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
        const text = mine ? await new Response(mine).text() : '';
        if (!res.ok) return { toolUses: [], input: 0, output: 0 };
        if (!res.headers.get('content-type')?.includes('event-stream')) {
          const msg: { content: { type: string; name?: string }[]; usage: { input_tokens: number; output_tokens: number } } = JSON.parse(text);
          return {
            toolUses: msg.content.flatMap((b) => (b.type === 'tool_use' && b.name ? [b.name] : [])),
            input: msg.usage.input_tokens,
            output: msg.usage.output_tokens,
          };
        }
        const events = text.split('\n').flatMap((line) => (line.startsWith('data: ') ? [JSON.parse(line.slice(6))] : []));
        let inputTokens = 0;
        let outputTokens = 0;
        const toolUses: string[] = [];
        for (const e of events) {
          if (e.type === 'message_start')
            inputTokens += e.message.usage.input_tokens + (e.message.usage.cache_read_input_tokens ?? 0) + (e.message.usage.cache_creation_input_tokens ?? 0);
          if (e.type === 'message_delta') outputTokens = e.usage.output_tokens;
          if (e.type === 'content_block_start' && e.content_block.type === 'tool_use') toolUses.push(e.content_block.name);
        }
        return { toolUses, input: inputTokens, output: outputTokens };
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
  world: World;
  scope: ReturnType<typeof testScope>;
  /** Each tool result the model read: its tool, whether it was a refusal, and its text. */
  results: { tool: string; ok: boolean; text: string }[];
  /** The drawer's drafted changes, from its answer's card. */
  drafts: ProposedCall[];
  /** The drawer's confirmation cards, as shown. */
  cards: ConfirmCard[];
}

export interface RunRecord {
  task: string;
  arm: Arm;
  role: Role;
  run: number;
  model: string;
  success: boolean;
  /** Why the check failed. */
  why?: string;
  toolCalls: number;
  refusedCalls: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  catalogue: { tools: number; bytes: number; tokens: number };
  /** How the run ended badly, if it did: the drawer's stream error, or /mcp's loop out of turns. */
  errors: string[];
}

export interface Task {
  id: string;
  prompt: string;
  role: Role;
  /** The arms it runs in, each with the calls a model that knows the tools makes: the scripted model's turns, and the fewest calls. */
  script: Partial<Record<Arm, (w: World) => Step[]>>;
  /** In the drawer, press the confirmation card the turn stops at, as the person would. */
  press?: true;
  /** Why the run failed, from the org and the tool outputs, never the model's words; undefined when it passed. */
  check: (o: Outcome) => Promise<string | undefined> | string | undefined;
}

/** The most model turns the /mcp loop takes, as a client would cut a run off. */
const MCP_TURNS = 20;
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
  now?: () => number;
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

/** The /mcp arm: the MCP SDK's client, as the member's agent, and the eval's own loop over Anthropic's Messages API. */
async function overMcp(task: Task, model: Model, log: ModelLog) {
  const t = testApp();
  const { member, world } = await team(t, task.role);
  const { access_token } = await agentToken(t, member, world.orgId, ALL_SCOPES);
  const client = new McpClient({ name: 'signforge-eval', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { fetch: worker, requestInit: { headers: { authorization: `Bearer ${access_token}` } } }),
  );
  const { tools } = await client.listTools();
  const catalogue = catalogueSize(tools);
  const defs = tools.map((x) => ({ name: x.name, description: x.description ?? '', input_schema: x.inputSchema }));
  const system = `${SYSTEM}\n${client.getInstructions() ?? ''}`;
  const ask = log.wrap(model.fetchFor(world));
  const messages: { role: 'user' | 'assistant'; content: unknown }[] = [{ role: 'user', content: task.prompt }];
  const errors: string[] = [];
  for (let turn = 0; ; turn++) {
    if (turn === MCP_TURNS) {
      errors.push('out_of_turns');
      break;
    }
    const res = await ask('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: model.id, max_tokens: MAX_TOKENS, system, tools: defs, messages }),
    });
    if (!res.ok) {
      errors.push(`model_${res.status}`);
      break;
    }
    const msg: { content: { type: string; id?: string; name?: string; input?: Record<string, unknown> }[]; stop_reason: string } = await res.json();
    messages.push({ role: 'assistant', content: msg.content });
    const uses = msg.content.filter((b) => b.type === 'tool_use');
    if (!uses.length) break;
    const results = [];
    for (const use of uses) {
      const result = await client.callTool({ name: use.name ?? '', arguments: use.input ?? {} });
      const text = result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');
      results.push({ type: 'tool_result', tool_use_id: use.id, content: text, ...(result.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }
  log.tail = messages;
  await client.close();
  return { world, catalogue, errors, drafts: [], cards: [] };
}

/** A drawer turn's server-sent events. */
const eventsOf = async (res: Response): Promise<{ type: string; name?: string; value?: any; code?: string }[]> =>
  (await res.text())
    .split('\n\n')
    .filter((e) => e.startsWith('data: '))
    .map((e) => JSON.parse(e.slice('data: '.length)));

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

/** The drawer arm: its chat route as the member, the org's model being `model`; a card the turn stops at pressed when the task says so. */
async function inDrawer(task: Task, model: Model, log: ModelLog) {
  // The model is the world's: a scripted one names its rows, which exist only once the org is seeded.
  let inner: typeof fetch = () => Promise.reject(new Error('the model was asked before the org was seeded'));
  const t = testApp({ agent: { reach: { fetch: log.wrap((input, init) => inner(input, init)), guards: NO_REACH }, ...(model.now ? { now: model.now } : {}) } });
  const { owner, member, world } = await team(t, task.role);
  inner = model.fetchFor(world);
  await saveProvider(owner, model.id, model.key);
  const errors: string[] = [];
  const cards: ConfirmCard[] = [];
  let drafts: ProposedCall[] = [];
  const read = (all: Awaited<ReturnType<typeof eventsOf>>) => {
    for (const e of all) {
      if (e.type === 'RUN_ERROR') errors.push(e.code ?? 'run_error');
      if (e.name === CHAT_EVENTS.confirm) cards.push(e.value);
      if (e.name === CHAT_EVENTS.answer) drafts = (e.value as AnswerCard).drafts;
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
  const first = log.exchanges[0]?.body.tools ?? [];
  const catalogue = catalogueSize(first.map(({ name, description, input_schema }) => ({ name, description, input_schema })));
  return { world, catalogue, errors, drafts, cards };
}

/**
 * Runs `task` in `arm` once with `model`, and checks it. A tool call is one the model asked for: the drawer's card
 * pause counts once, its press does not again. A refused call is a tool result marked as an error.
 */
export async function runTask(task: Task, arm: Arm, model: Model, runNo = 1): Promise<RunRecord> {
  const log = new ModelLog();
  const ran = arm === 'mcp' ? await overMcp(task, model, log) : await inDrawer(task, model, log);
  const answers = await Promise.all(log.exchanges.map((e) => e.answered));
  const results = log.results();
  const outcome: Outcome = { arm, world: ran.world, scope: testScope(env.DB, ran.world.orgId), results, drafts: ran.drafts, cards: ran.cards };
  const why = await task.check(outcome);
  return {
    task: task.id,
    arm,
    role: task.role,
    run: runNo,
    model: model.label,
    success: why === undefined,
    ...(why === undefined ? {} : { why }),
    toolCalls: answers.reduce((n, a) => n + a.toolUses.length, 0),
    refusedCalls: results.filter((r) => !r.ok).length,
    modelCalls: log.exchanges.length,
    inputTokens: answers.reduce((n, a) => n + a.input, 0),
    outputTokens: answers.reduce((n, a) => n + a.output, 0),
    catalogue: ran.catalogue,
    errors: ran.errors,
  };
}

/** The scripted model for `task` in `arm`: its script's turns, then its answer, on a fixed clock. */
export function scriptedModel(task: Task, arm: Arm, now: () => number, turns = task.script[arm]): Model {
  if (!turns) throw new Error(`${task.id} does not run in ${arm}`);
  return { id: SCRIPTED_AS, label: 'scripted', key: SCRIPTED_KEY, now, fetchFor: (w) => scripted(turns(w), arm) };
}

/** A live model on Anthropic's API with `key`, on the real clock: a turn's time budget is the drawer's own. */
export const liveModel = (id: string, key: string): Model => ({ id, label: id, key, fetchFor: () => live(key) });
