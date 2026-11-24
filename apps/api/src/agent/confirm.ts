/**
 * The tools the agent's drawer runs only when the person presses a confirmation card (#269, #351,
 * docs/proposals/cms-agent.md): publishing, taking over, ending a takeover, deleting, revoking, a live
 * screen command, and every tool that reaches an address. The model may ask for one; TanStack AI's
 * `needsApproval` pauses the run there, before it runs, and the card says what it would do, read from
 * the org now: to what, how many screens, until when, whether it can be undone, and an address in full.
 *
 * What a press may run is fixed when the card is made (`input`): the versions and pins it showed, never
 * what is there at the press. The card's record is kept in the org's Durable Object under a one-use
 * token (`Confirmation`, src/publish.ts); a press takes it, once, for the member it was made for,
 * before it runs out, and only with the input exactly as shown. It then runs through the dispatcher as
 * the member, so their role and scopes are checked as they press, and the audit row carries the card's
 * summary (`Caller.confirmed`).
 */
import { type OrgScope, type PlaylistRow, published } from '@signforge/db';
import {
  type Caller,
  dispatch,
  type DispatchResult,
  type DraftPin,
  type Grant,
  OVERRIDE_LIMIT_MS,
  permits,
  publishOrg,
  refusedPress,
  registry,
  type SampleAck,
  sha256Hex,
  ToolError,
} from '@signforge/tools';
import { z } from 'zod';
import type { ConfirmCard } from './chat-shapes';

type Row = Record<string, unknown>;

/** How long a card may be pressed. */
export const CONFIRM_MS = 10 * 60_000;

/** A card's content, before its token: what it says, and what a press runs. */
interface Made {
  card: Omit<ConfirmCard, 'tool' | 'token' | 'why' | 'expiresAt'>;
  input: Row;
  /** Lines naming what the audit log redacts (a provider's resource): shown to the person, kept out of the audit row's summary. */
  withheld?: readonly string[];
}

interface Confirmable {
  /** The registry tools a press runs, whose rights the member needs. */
  tools: readonly string[];
  /** The model's input, as it is offered (a registry tool's, unless the tool is the drawer's own). */
  schema: () => Record<string, unknown>;
  description: () => string;
  /** The card, read from the org now; a refusal (thrown `CardProblem`) when it cannot be one. */
  make: (org: OrgScope, called: Row, at: When) => Promise<Made>;
  /** What a press runs, with the input the card fixed. */
  run: (caller: Caller, input: Row) => Promise<DispatchResult>;
}

/** Why a call cannot be a card: said to the model as the tool's error. */
export class CardProblem extends Error {}

/** Times in the org's own zone, as the card says them. */
interface When {
  now: number;
  timeZone: string;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const ofRegistry = (name: string) => () => {
  const tool = registry.get(name);
  if (!tool) throw new Error(`no registry tool ${name}`);
  return z.toJSONSchema(tool.input, { io: 'input', unrepresentable: 'any' });
};
const describedAs = (name: string) => () => registry.get(name)?.description ?? '';
const run = (name: string) => (caller: Caller, input: Row) => dispatch(registry, name, input, caller);

const timeOf = (ms: number, at: When) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: at.timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(ms);

async function screenNamed(org: OrgScope, id: unknown) {
  const screen = await org.screens.get(str(id));
  if (!screen) throw new CardProblem(`no screen ${str(id)}`);
  return screen;
}

const screensWord = (n: number) => (n === 1 ? '1 screen' : `${n} screens`);
const screensPlay = (n: number) => (n === 1 ? '1 screen plays' : `${n} screens play`);

/** Where an entry plays, in words, and the screens it reaches now, by id, sorted: what a takeover's card binds. */
async function reachOf(org: OrgScope, v: Row): Promise<{ words: string; screens: string[] }> {
  if (v.target === 'group') {
    const group = await org.screenGroups.get(str(v.groupId));
    if (!group) throw new CardProblem(`no group ${str(v.groupId)}`);
    const screens = (await org.screenGroups.members(group.id)).sort();
    return { words: `on the ${group.name} group (${screensWord(screens.length)})`, screens };
  }
  if (v.target === 'screen') {
    const screen = await screenNamed(org, v.screenId);
    return { words: `on ${screen.name}`, screens: [screen.id] };
  }
  const screens = (await org.screens.list()).map((s) => s.id).sort();
  return { words: `on every screen (${screensWord(screens.length)})`, screens };
}

/** A press refused before it runs anything, as the org is not as the card showed it: audited as a refused press of `tool`. */
const changedSince = (caller: Caller, tool: string, input: Row, what: string): Promise<DispatchResult> =>
  refusedPress(registry, tool, input, caller, { ok: false, error: 'conflict', message: `${what} since the card was made: ask again for a new one` });

/** A playlist's spots, each at the version screens have of it (null: never published): published items, or its draft's if never published. */
async function spotsLive(org: OrgScope, playlist: PlaylistRow): Promise<Record<string, number | null>> {
  const items = published(playlist)?.items ?? (await org.playlists.items(playlist.id));
  const rows = await Promise.all(items.map((id) => org.spots.get(id)));
  return Object.fromEntries(rows.flatMap((s) => (s ? [[s.id, s.publishedVersion]] : [])));
}

/** What a publish would do, worked out as it would, writing nothing: what a publish card shows and a press holds it to. */
async function publishSees(org: OrgScope, pins: DraftPin[], allow: SampleAck[], now: number) {
  const dry = await publishOrg(org, { hash: sha256Hex, now: new Date(now) }, pins, [], false, allow);
  return {
    dry,
    bound: {
      // The screens it would switch, the default and the brand kits their manifests are compiled with.
      screens: dry.screens.flatMap((x) => (x.manifest && x.manifest.id !== x.current ? [x.screenId] : [])).sort(),
      defaultPlaylistId: dry.read.defaultPlaylist,
      brand: dry.brand,
    },
  };
}

/** A publish card's record: the publish's input, and what the card showed it would reach. */
const publishBound = z.object({
  call: z.looseObject({
    drafts: z.array(z.object({ kind: z.enum(['spot', 'playlist', 'schedule_entry']), id: z.string(), version: z.number() })),
    allowSample: z.array(z.object({ spotId: z.string(), version: z.number(), fields: z.array(z.string()) })).optional(),
  }),
  bound: z.object({ screens: z.array(z.string()), defaultPlaylistId: z.string().nullable(), brand: z.string() }),
});

/** Each draft pinned, at the version read now, by its name: what the card shows is what a press publishes. */
async function pinsOf(org: OrgScope, drafts: unknown): Promise<{ pins: DraftPin[]; names: string[] }> {
  if (!Array.isArray(drafts) || !drafts.length) throw new CardProblem('name the drafts to publish (drafts), each { kind, id }: a publish from here is pinned');
  const pins: DraftPin[] = [];
  const names: string[] = [];
  for (const d of drafts) {
    const kind = d?.kind;
    const id = str(d?.id);
    if (kind !== 'spot' && kind !== 'playlist' && kind !== 'schedule_entry')
      throw new CardProblem(`no draft kind ${str(kind)}: spot, playlist or schedule_entry`);
    const row =
      kind === 'spot'
        ? await org.spots.get(id)
        : kind === 'playlist'
          ? await org.playlists.get(id)
          : kind === 'schedule_entry'
            ? await org.scheduleEntries.get(id)
            : undefined;
    if (!row) throw new CardProblem(`no ${kind} ${id}`);
    pins.push({ kind, id, version: row.rowVersion });
    names.push(kind === 'schedule_entry' ? 'A schedule entry' : `${kind === 'spot' ? 'Spot' : 'Playlist'} ${'name' in row ? row.name : id}`);
  }
  return { pins, names };
}

/** What a publish refused for sample text names (#360): each spot, at its version, and its fields still holding the sample. */
const sampleRefusal = z.object({ spots: z.array(z.object({ id: z.string(), name: z.string(), version: z.number(), fields: z.array(z.string()) })) });

/** A calendar's or a sheet's source: the resource read at the provider, in full, through its connection (#351 review). */
const resourceLines = (called: Row) => (called.resource === undefined ? [] : [`Reads this at the provider, through its connection: ${str(called.resource)}`]);

/** An address card's lines: the address in full, and what fetches it. */
const addressOf = (url: unknown, fetches: string) => {
  if (!str(url)) throw new CardProblem('no address given');
  return { url: str(url), fetches };
};

export const CONFIRMABLE: Readonly<Record<string, Confirmable>> = {
  publish: {
    tools: ['publish'],
    schema: ofRegistry('publish'),
    description: describedAs('publish'),
    async make(org, called, at) {
      const { pins, names } = await pinsOf(org, called.drafts);
      const settings = await org.settings.get();
      // The model's ifDefault as asked, else the default if pinned (#393): refused if it is no longer the default by then.
      const ifDefault = str(called.ifDefault) || pins.find((p) => p.kind === 'playlist' && p.id === settings?.defaultPlaylistId)?.id;
      // What it would change, worked out as the publish would, writing nothing: the screens it reaches, and what it holds
      // back. A spot still holding its template's sample text (#360, #392) is listed on the card, exactly as the publish
      // would refuse it, and acknowledged by the press: the model's own allowSample, which an agent may not give, is never taken.
      const dryRun = (allow: SampleAck[]) => publishSees(org, pins, allow, at.now);
      let samples: z.output<typeof sampleRefusal>['spots'] = [];
      let seen: Awaited<ReturnType<typeof publishSees>>;
      try {
        seen = await dryRun([]).catch(async (err: unknown) => {
          if (!(err instanceof ToolError) || err.code !== 'sample_text') throw err;
          samples = sampleRefusal.parse(err.details).spots;
          return dryRun(samples.map((x) => ({ spotId: x.id, version: x.version, fields: x.fields })));
        });
      } catch (err) {
        if (err instanceof ToolError) throw new CardProblem(err.message, { cause: err });
        throw err;
      }
      const { dry, bound } = seen;
      const reach = bound.screens.length;
      const { allowSample: _theirs, ...asked } = called;
      return {
        input: {
          // Every constraint the model gave, as it gave them, with the pins at the versions shown and the samples the card lists.
          call: {
            ...asked,
            drafts: pins,
            ...(ifDefault ? { ifDefault } : {}),
            ...(samples.length ? { allowSample: samples.map((x) => ({ spotId: x.id, version: x.version, fields: x.fields })) } : {}),
          },
          // What the card says it reaches: a press refuses if a screen, the default or a brand kit has changed it since.
          bound,
        },
        card: {
          title: 'Publish to screens',
          lines: [
            ...names.map((n) => `${n}, as drafted now`),
            reach ? `Changes what ${screensPlay(reach)}; each switches as it hears of it.` : 'Changes what no screen plays now.',
            ...(dry.drafts.held.length
              ? [`${dry.drafts.held.length === 1 ? 'One draft fails' : `${dry.drafts.held.length} drafts fail`} its checks and keeps its published version.`]
              : []),
            ...samples.map((x) => `${x.name} still shows its template's sample text (${x.fields.join(', ')}): pressing publishes it anyway.`),
          ],
          address: null,
          when: 'Now',
          undo: 'Undo from the publish toast, or roll back on the Publishes page.',
          press: 'Publish',
        },
      };
    },
    async run(caller, input) {
      const { call, bound } = publishBound.parse(input);
      // Read again as the press would publish: a pin changed or a check refused is the publish's own refusal, from dispatch.
      const now = await publishSees(caller.org, call.drafts, call.allowSample ?? [], Date.now()).catch((err: unknown) => {
        if (err instanceof ToolError) return undefined;
        throw err;
      });
      if (now && now.bound.defaultPlaylistId !== bound.defaultPlaylistId) return changedSince(caller, 'publish', call, 'The default playlist changed');
      if (now && now.bound.brand !== bound.brand) return changedSince(caller, 'publish', call, 'The brand kits changed');
      if (now && canonical(now.bound.screens) !== canonical(bound.screens)) return changedSince(caller, 'publish', call, 'The screens it would switch changed');
      return dispatch(registry, 'publish', call, caller);
    },
  },
  start_takeover: {
    tools: ['publish_takeover'],
    schema: ofRegistry('start_takeover'),
    description: () => `${registry.get('start_takeover')?.description ?? ''} From the drawer it is published at once when the person presses its card.`,
    async make(org, called, at) {
      const playlist = await org.playlists.get(str(called.playlistId));
      if (!playlist) throw new CardProblem(`no playlist ${str(called.playlistId)}`);
      const ends = Date.parse(str(called.endsAt));
      if (!Number.isFinite(ends)) throw new CardProblem('give endsAt, when the takeover ends');
      const starts = called.startsAt ? Date.parse(str(called.startsAt)) : at.now;
      // Its playlist, and that playlist's spots, published with it if never published: it cannot play without them.
      const fresh = playlist.publishedJson === null;
      const spots = await spotsLive(org, playlist);
      const unpublished = fresh ? (await Promise.all(Object.keys(spots).map((id) => org.spots.get(id)))).filter((s) => s && s.publishedJson === null) : [];
      const also = fresh
        ? [
            { kind: 'playlist', id: playlist.id, version: playlist.rowVersion },
            ...unpublished.map((s) => ({ kind: 'spot', id: s?.id, version: s?.rowVersion })),
          ]
        : [];
      const { idempotencyKey: _key, ...start } = called;
      const reach = await reachOf(org, called);
      return {
        // What it plays, on which screens: a press refuses if any changed since (the group's screens, the playlist or a spot of it published again).
        input: { start, with: also, reach: reach.screens, live: playlist.publishedJson, spots },
        card: {
          title: 'Take over screens',
          lines: [
            `Plays ${playlist.name} ${reach.words}, over anything scheduled.`,
            `From ${starts <= at.now ? 'now' : timeOf(starts, at)} until ${timeOf(ends, at)}.`,
            ...(fresh ? [`Publishes ${playlist.name} too: it was never published.`] : []),
          ],
          address: null,
          when: starts <= at.now ? 'Now' : timeOf(starts, at),
          undo: 'End it early with End now on the Schedule.',
          press: 'Take over',
        },
      };
    },
    async run(caller, input) {
      const start = typeof input.start === 'object' && input.start !== null ? Object.fromEntries(Object.entries(input.start)) : {};
      const call = { ...start, with: input.with };
      // The screens it reaches, and what its playlist and spots play, as the card showed them: else nothing is done.
      const reach = await reachOf(caller.org, start).catch((err: unknown) => {
        if (err instanceof CardProblem) return undefined;
        throw err;
      });
      if (!reach) return changedSince(caller, 'publish_takeover', call, 'Its group or screen was deleted');
      if (canonical(reach.screens) !== canonical(input.reach)) return changedSince(caller, 'publish_takeover', call, 'The screens it would play on changed');
      const playlist = await caller.org.playlists.get(str(start.playlistId));
      if (!playlist || playlist.publishedJson !== input.live) return changedSince(caller, 'publish_takeover', call, 'Its playlist was published again');
      if (canonical(await spotsLive(caller.org, playlist)) !== canonical(input.spots))
        return changedSince(caller, 'publish_takeover', call, 'A spot of its playlist was published again');
      // Made and published in one batch, or not at all (`publish_takeover`).
      return dispatch(registry, 'publish_takeover', call, caller);
    },
  },
  end_takeover: {
    tools: ['end_takeover'],
    schema: ofRegistry('end_takeover'),
    description: describedAs('end_takeover'),
    async make(org, called) {
      const entry = await org.scheduleEntries.get(str(called.scheduleEntryId));
      if (!entry || entry.endsAt === null) throw new CardProblem(`no takeover ${str(called.scheduleEntryId)}`);
      const playlist = await org.playlists.get(entry.playlistId);
      return {
        input: { scheduleEntryId: entry.id, version: entry.rowVersion },
        card: {
          title: 'End the takeover',
          lines: [`Stops ${playlist?.name ?? 'the takeover'} ${(await reachOf(org, entry)).words}: they go back to what is scheduled.`],
          address: null,
          when: 'Now',
          undo: 'No undo: start another takeover.',
          press: 'End now',
        },
      };
    },
    async run(caller, input) {
      const call = { scheduleEntryId: str(input.scheduleEntryId) };
      if ((await caller.org.scheduleEntries.get(call.scheduleEntryId))?.rowVersion !== input.version)
        return changedSince(caller, 'end_takeover', call, 'The takeover changed');
      return dispatch(registry, 'end_takeover', call, caller);
    },
  },
  delete_playlist: {
    tools: ['delete_playlist'],
    schema: ofRegistry('delete_playlist'),
    description: describedAs('delete_playlist'),
    async make(org, called) {
      const playlist = await org.playlists.get(str(called.playlistId));
      if (!playlist) throw new CardProblem(`no playlist ${str(called.playlistId)}`);
      return {
        input: { playlistId: playlist.id, version: playlist.rowVersion },
        card: {
          title: 'Delete a playlist',
          lines: [`Deletes ${playlist.name}, its draft and its published version. Its spots stay.`],
          address: null,
          when: 'Now',
          undo: 'No undo.',
          press: 'Delete',
        },
      };
    },
    async run(caller, input) {
      const call = { playlistId: str(input.playlistId) };
      if ((await caller.org.playlists.get(call.playlistId))?.rowVersion !== input.version)
        return changedSince(caller, 'delete_playlist', call, 'The playlist changed');
      return dispatch(registry, 'delete_playlist', call, caller);
    },
  },
  delete_schedule_entry: {
    tools: ['delete_schedule_entry'],
    schema: ofRegistry('delete_schedule_entry'),
    description: describedAs('delete_schedule_entry'),
    async make(org, called) {
      const entry = await org.scheduleEntries.get(str(called.scheduleEntryId));
      if (!entry) throw new CardProblem(`no schedule entry ${str(called.scheduleEntryId)}`);
      const playlist = await org.playlists.get(entry.playlistId);
      return {
        input: { scheduleEntryId: entry.id, ifVersion: entry.rowVersion },
        card: {
          title: 'Remove a schedule entry',
          lines: [`Removes ${playlist?.name ?? 'its playlist'} ${(await reachOf(org, entry)).words}.`],
          address: null,
          when: entry.publishedJson === null ? 'Now: it was never published' : 'At the next publish: screens keep it until then',
          undo: 'No undo: schedule it again.',
          press: 'Remove',
        },
      };
    },
    run: run('delete_schedule_entry'),
  },
  revoke_screen_credential: {
    tools: ['revoke_screen_credential'],
    schema: ofRegistry('revoke_screen_credential'),
    description: describedAs('revoke_screen_credential'),
    async make(org, called) {
      const screen = await screenNamed(org, called.screenId);
      return {
        input: { screenId: screen.id, credentialId: str(called.credentialId) },
        card: {
          title: "Revoke a screen's credential",
          lines: [`${screen.name}'s device stops playing at once and must be paired again.`],
          address: null,
          when: 'Now',
          undo: 'No undo: pair the screen again.',
          press: 'Revoke',
        },
      };
    },
    run: run('revoke_screen_credential'),
  },
  set_display_override: {
    tools: ['set_display_override'],
    schema: ofRegistry('set_display_override'),
    description: describedAs('set_display_override'),
    async make(org, called) {
      const screen = await screenNamed(org, called.screenId);
      const state = called.state === 'on' || called.state === 'off' ? called.state : null;
      return {
        input: { screenId: screen.id, state },
        card: {
          title: state === null ? 'Follow display hours again' : `Turn the display ${state}`,
          lines: [
            state === null
              ? `${screen.name} follows its display hours again.`
              : `${screen.name}'s display turns ${state} now, whatever its display hours say, until its next scheduled display change, or ${OVERRIDE_LIMIT_MS / 3_600_000} hours at most, then follows its hours again.`,
          ],
          address: null,
          when: 'Now, on the live screen',
          undo: state === null ? 'Turn it on or off again here.' : 'Set it to follow its display hours again, or wait: it ends by itself.',
          press: state === null ? 'Follow hours' : `Turn ${state}`,
        },
      };
    },
    run: run('set_display_override'),
  },
  restart_screen: {
    tools: ['restart_screen'],
    schema: ofRegistry('restart_screen'),
    description: describedAs('restart_screen'),
    async make(org, called) {
      const screen = await screenNamed(org, called.screenId);
      return {
        input: { screenId: screen.id },
        card: {
          title: 'Restart a screen',
          lines: [`${screen.name} restarts now: it goes blank for a moment, then plays again.`],
          address: null,
          when: 'Now, on the live screen',
          undo: 'Nothing to undo.',
          press: 'Restart',
        },
      };
    },
    run: run('restart_screen'),
  },
  identify_screen: {
    tools: ['identify_screen'],
    schema: ofRegistry('identify_screen'),
    description: describedAs('identify_screen'),
    async make(org, called) {
      const screen = await screenNamed(org, called.screenId);
      return {
        input: { screenId: screen.id },
        card: {
          title: 'Identify a screen',
          lines: [`${screen.name} shows its name over what it plays, for a few seconds.`],
          address: null,
          when: 'Now, on the live screen',
          undo: 'Nothing to undo.',
          press: 'Identify',
        },
      };
    },
    run: run('identify_screen'),
  },
  read_table: {
    tools: ['read_table'],
    schema: ofRegistry('read_table'),
    description: describedAs('read_table'),
    async make(_org, called) {
      return {
        input: called,
        card: {
          title: 'Read a table from an address',
          lines: ['The server fetches the address once, now, and the agent reads what it finds.'],
          address: addressOf(called.feedUrl, 'The server, once, now'),
          when: 'Now',
          undo: 'Nothing is written.',
          press: 'Fetch it',
        },
      };
    },
    run: run('read_table'),
  },
  create_data_source: {
    tools: ['create_data_source'],
    schema: ofRegistry('create_data_source'),
    description: describedAs('create_data_source'),
    async make(_org, called) {
      const minutes = Math.max(1, Math.round(Number(called.refreshS ?? 60) / 60));
      return {
        input: { ...called, idempotencyKey: str(called.idempotencyKey) || crypto.randomUUID() },
        withheld: resourceLines(called),
        card: {
          title: 'Add a data source',
          lines: [
            `Adds ${str(called.name) || 'a data source'}, read from ${called.resource === undefined ? 'the address below' : 'its connection'}.`,
            ...resourceLines(called),
          ],
          address: called.feedUrl === undefined ? null : addressOf(called.feedUrl, `The poller, every ${minutes === 1 ? 'minute' : `${minutes} minutes`}`),
          when: 'Now: the poller starts reading it',
          undo: 'Delete the data source on the Integrations page.',
          press: 'Add it',
        },
      };
    },
    run: run('create_data_source'),
  },
  update_data_source: {
    tools: ['update_data_source'],
    schema: ofRegistry('update_data_source'),
    description: describedAs('update_data_source'),
    async make(org, called) {
      const source = await org.dataSources.get(str(called.dataSourceId));
      if (!source) throw new CardProblem(`no data source ${str(called.dataSourceId)}`);
      return {
        input: { ...called, ifVersion: source.rowVersion },
        withheld: resourceLines(called),
        card: {
          title: 'Change a data source',
          lines: [
            `Changes ${source.name}: ${
              Object.keys(called)
                .filter((k) => k !== 'dataSourceId' && k !== 'ifVersion')
                .join(', ') || 'nothing'
            }.`,
            ...resourceLines(called),
          ],
          address: called.feedUrl === undefined ? null : addressOf(called.feedUrl, 'The poller, at its next read'),
          when: 'Now: screens get what it reads next',
          undo: 'Change it back on the Integrations page.',
          press: 'Change it',
        },
      };
    },
    run: run('update_data_source'),
  },
  set_spot_url: {
    tools: ['update_spot'],
    schema: () => ({
      type: 'object',
      properties: { spotId: { type: 'string', description: 'The web page spot' }, url: { type: 'string', description: 'The https address it shows' } },
      required: ['spotId', 'url'],
      additionalProperties: false,
    }),
    description: () =>
      "Set a web page spot's address: the page its stage and screens open. From the drawer the person sees the address in full and presses to save it as the spot's draft.",
    async make(org, called) {
      const spot = await org.spots.get(str(called.spotId));
      if (!spot) throw new CardProblem(`no spot ${str(called.spotId)}`);
      if (spot.kind !== 'url') throw new CardProblem(`${spot.name} is not a web page spot`);
      return {
        input: { spotId: spot.id, url: str(called.url), ifVersion: spot.rowVersion },
        card: {
          title: "Set a web page spot's address",
          lines: [`${spot.name} shows the page at the address below, as its draft.`],
          address: addressOf(called.url, 'The stage, now, and screens once it is published'),
          when: 'Saved as a draft now; screens at the next publish',
          undo: 'Change the address back in the spot editor.',
          press: 'Save the address',
        },
      };
    },
    run: run('update_spot'),
  },
};

/** Who may press the card: null when `grant` permits every tool it runs, else who to ask. */
export function whyNot(grant: Grant, name: string): string | null {
  const tools = (CONFIRMABLE[name]?.tools ?? []).flatMap((t) => registry.get(t) ?? []);
  if (tools.every((t) => permits(grant, t))) return null;
  if (tools.some((t) => t.minRole === 'owner')) return 'Only owners can do this: ask an owner.';
  if (tools.some((t) => t.scope === 'content:publish') && grant.role === 'editor') return 'Only owners publish in this organization: ask an owner.';
  return 'You can view only: ask an editor.';
}

/** A card's input as one string, keys in order at every depth: what its token is bound to. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(Reflect.get(value, k))}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
