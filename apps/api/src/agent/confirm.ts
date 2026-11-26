/**
 * The tools the agent's drawer runs only when the person presses a confirmation card (#269, #351,
 * docs/proposals/cms-agent.md): publishing, taking over, ending a takeover, deleting, revoking, a live
 * screen command, cancelling an invitation (#321), and every tool that reaches an address. The model may ask for one; TanStack AI's
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
  effectiveScopes,
  entryToDelete,
  type Grant,
  OVERRIDE_LIMIT_MS,
  orgGroups,
  permits,
  dryPublish,
  reachesScreens,
  registry,
  saveDataSourceInput,
  sha256Hex,
  sourceRefusal,
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
  /** Lines naming what the audit log redacts (a provider's resource, an invitee's address): shown to the person, kept out of the audit row's summary. */
  withheld?: readonly string[];
}

interface Confirmable {
  /** The registry tools a press runs, whose rights the member needs. */
  tools: readonly string[];
  /** The model's input, as it is offered and checked before a card is made (a registry tool's, unless the tool is the drawer's own). */
  input: (grant: Grant) => z.ZodType;
  description: () => string;
  /**
   * Whether this call needs the right to publish though its tool's scope is less: the press would be refused without it,
   * so the card says who may instead (review of #419). As the tool's handler asks it of an agent, the drawer's included.
   * Read from the org when it depends on a row (a schedule entry already published, #523).
   */
  needsPublish?: (called: Row, org: OrgScope) => boolean | Promise<boolean>;
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
/** A tool's input as `grant` is listed it: without what only the card fills in (`takeover`'s guards, #408). */
const ofRegistry = (name: string) => (grant: Grant) => {
  const tool = registry.get(name);
  if (!tool) throw new Error(`no registry tool ${name}`);
  return tool.listedInput?.(grant) ?? tool.input;
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
    // A smart group's are the screens its rule matches now (#186), as the takeover will reach them.
    const screens = (await orgGroups(org)).screensIn(group.id);
    return { words: `on the ${group.name} group (${screensWord(screens.length)})`, screens };
  }
  if (v.target === 'screen') {
    const screen = await screenNamed(org, v.screenId);
    return { words: `on ${screen.name}`, screens: [screen.id] };
  }
  const screens = (await org.screens.list()).map((s) => s.id).sort();
  return { words: `on every screen (${screensWord(screens.length)})`, screens };
}

/** A playlist's spots, each at the version screens have of it (null: never published): published items, or its draft's if never published. */
async function spotsLive(org: OrgScope, playlist: PlaylistRow): Promise<Record<string, number | null>> {
  const items = published(playlist)?.items ?? (await org.playlists.items(playlist.id));
  const rows = await Promise.all(items.map((id) => org.spots.get(id)));
  return Object.fromEntries(rows.flatMap((s) => (s ? [[s.id, s.publishedVersion]] : [])));
}

/**
 * What a publish would do, worked out as it would, writing nothing: what a publish card shows and a press is held to. A spot
 * still holding its template's sample text (#360, #392) is named, exactly as the publish would refuse it (`dryPublish`).
 */
async function publishSees(org: OrgScope, pins: DraftPin[], now: number) {
  const { result: dry, samples } = await dryPublish(org, { hash: sha256Hex, now: new Date(now) }, pins, false);
  return {
    dry,
    samples,
    // The screens it would switch, the default and the brand kits their manifests are compiled with: the publish's guards.
    held: {
      ifScreens: dry.screens.flatMap((x) => (x.manifest && x.manifest.id !== x.current ? [x.screenId] : [])).sort(),
      ifDefault: dry.read.defaultPlaylist,
      ifBrand: dry.brand,
    },
  };
}

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
    input: ofRegistry('publish'),
    description: describedAs('publish'),
    async make(org, called, at) {
      const { pins, names } = await pinsOf(org, called.drafts);
      // What it would change, worked out as the publish would, writing nothing: the screens it reaches, and what it holds
      // back. A spot still holding its template's sample text (#360, #392) is listed on the card, exactly as the publish
      // would refuse it, and acknowledged by the press: the model's own allowSample, which an agent may not give, is never taken.
      let seen: Awaited<ReturnType<typeof publishSees>>;
      try {
        seen = await publishSees(org, pins, at.now);
      } catch (err) {
        if (err instanceof ToolError) throw new CardProblem(err.message, { cause: err });
        throw err;
      }
      const { dry, held, samples } = seen;
      const reach = held.ifScreens.length;
      const { allowSample: _theirs, ...asked } = called;
      return {
        // Every constraint the model gave, as it gave them (its ifDefault, #393, else the default now), with the pins at the
        // versions shown and the samples the card lists; and what the card says it reaches, which the publish holds to its
        // commit: the screens it switches, the default and the brand kits (#386's guards). Any changed since refuses the press.
        input: {
          ...asked,
          ...held,
          ...(called.ifDefault !== undefined ? { ifDefault: called.ifDefault } : {}),
          drafts: pins,
          ...(samples.length ? { allowSample: samples.map((x) => ({ spotId: x.id, version: x.version, fields: x.fields })) } : {}),
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
    run: run('publish'),
  },
  // A takeover published now, or one ended now: one card each, by action (#345).
  takeover: {
    tools: ['takeover'],
    input: ofRegistry('takeover'),
    description: () => `${registry.get('takeover')?.description ?? ''} From the drawer, the person presses its card.`,
    async make(org, called, at) {
      if (called.action === 'end') {
        const entry = await org.scheduleEntries.get(str(called.scheduleEntryId));
        if (!entry || entry.endsAt === null) throw new CardProblem(`no takeover ${str(called.scheduleEntryId)}`);
        const playlist = await org.playlists.get(entry.playlistId);
        return {
          input: { action: 'end', scheduleEntryId: entry.id, version: entry.rowVersion },
          card: {
            title: 'End the takeover',
            lines: [`Stops ${playlist?.name ?? 'the takeover'} ${(await reachOf(org, entry)).words}: they go back to what is scheduled.`],
            address: null,
            when: 'Now',
            undo: 'No undo: start another takeover.',
            press: 'End now',
          },
        };
      }
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
      // What the card pins is its own: the model's with is not taken.
      const { action: _action, with: _with, ...start } = called;
      const reach = await reachOf(org, called);
      return {
        // What it plays, on which screens: the press holds the tool to them through its commit (#408).
        input: { start, with: also, reach: reach.screens, plays: { playlist: playlist.publishedVersion, spots } },
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
      // The tool checks what the card showed in the batch it writes in, so nothing changed meanwhile slips between (#408).
      if (input.action === 'end')
        return dispatch(registry, 'takeover', { action: 'end', scheduleEntryId: input.scheduleEntryId, ifVersion: input.version }, caller);
      const start = typeof input.start === 'object' && input.start !== null ? Object.fromEntries(Object.entries(input.start)) : {};
      // Made and published in one batch, or not at all, on the screens and with the content the card showed (`takeover`).
      return dispatch(registry, 'takeover', { action: 'publish', ...start, with: input.with, ifReach: input.reach, ifPlays: input.plays }, caller);
    },
  },
  // The drawer deletes a playlist or a schedule entry, as it did before `delete` took every type (#345): no asset or source.
  delete: {
    tools: ['delete'],
    // A published entry's removal reaches screens at the next publish: the tool asks the right to publish (#523).
    needsPublish: async (called, org) => called.type === 'schedule_entry' && ((await entryToDelete(org, str(called.id)))?.needsPublish ?? false),
    input: () =>
      z
        .strictObject({
          type: z.enum(['playlist', 'schedule_entry']),
          id: z.string().describe('The playlist or schedule entry'),
        })
        .describe('What to delete'),
    description: () =>
      'Delete a playlist, its draft and its published version (not its spots; refused while it is the default or scheduled), or a schedule entry or takeover (one published waits for the next publish). To end a takeover now, use takeover (action end). From the drawer, the person presses its card.',
    async make(org, called) {
      if (called.type === 'playlist') {
        const playlist = await org.playlists.get(str(called.id));
        if (!playlist) throw new CardProblem(`no playlist ${str(called.id)}`);
        return {
          input: { type: 'playlist', id: playlist.id, version: playlist.rowVersion },
          card: {
            title: 'Delete a playlist',
            lines: [`Deletes ${playlist.name}, its draft and its published version. Its spots stay.`],
            address: null,
            when: 'Now',
            undo: 'No undo.',
            press: 'Delete',
          },
        };
      }
      const entry = (await entryToDelete(org, str(called.id)))?.row;
      if (!entry) throw new CardProblem(`no schedule entry ${str(called.id)}`);
      const playlist = await org.playlists.get(entry.playlistId);
      return {
        input: { type: 'schedule_entry', id: entry.id, ifVersion: entry.rowVersion },
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
    async run(caller, input) {
      if (input.type === 'schedule_entry') return dispatch(registry, 'delete', input, caller);
      // Held to the version the card showed through the commit (#408).
      return dispatch(registry, 'delete', { type: 'playlist', id: input.id, ifVersion: input.version }, caller);
    },
  },
  // An invitation cancelled cannot be undone by the agent: only a person invites again (#321).
  cancel_invitation: {
    tools: ['cancel_invitation'],
    input: ofRegistry('cancel_invitation'),
    description: describedAs('cancel_invitation'),
    async make(org, called) {
      const invitation = await org.invitations.get(str(called.invitationId));
      if (invitation?.status !== 'pending') throw new CardProblem(`no pending invitation ${str(called.invitationId)}`);
      const whose = `The invitation for ${invitation.email}${invitation.role ? ` as ${invitation.role}` : ''} stops working: its link no longer lets them in.`;
      return {
        input: { invitationId: invitation.id },
        // The invitee's address: only owners read it in the audit log, so the summary every member reads leaves it out.
        withheld: [whose],
        card: {
          title: 'Cancel an invitation',
          lines: [whose],
          address: null,
          when: 'Now',
          undo: 'No undo: an owner invites them again.',
          press: 'Cancel the invitation',
        },
      };
    },
    run: run('cancel_invitation'),
  },
  revoke_screen_credential: {
    tools: ['revoke_screen_credential'],
    input: ofRegistry('revoke_screen_credential'),
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
  screen_command: {
    tools: ['screen_command'],
    input: ofRegistry('screen_command'),
    description: describedAs('screen_command'),
    async make(org, called) {
      const screen = await screenNamed(org, called.screenId);
      const live = 'Now, on the live screen';
      const command = str(called.command);
      // Each command its own card: what the person sees before they press is what that command does.
      const cards: Record<string, Made['card']> = {
        identify: {
          title: 'Identify a screen',
          lines: [`${screen.name} shows its name over what it plays, for a few seconds.`],
          address: null,
          when: live,
          undo: 'Nothing to undo.',
          press: 'Identify',
        },
        restart: {
          title: 'Restart a screen',
          lines: [`${screen.name} restarts now: it goes blank for a moment, then plays again.`],
          address: null,
          when: live,
          undo: 'Nothing to undo.',
          press: 'Restart',
        },
        display_auto: {
          title: 'Follow display hours again',
          lines: [`${screen.name} follows its display hours again.`],
          address: null,
          when: live,
          undo: 'Turn it on or off again here.',
          press: 'Follow hours',
        },
      };
      for (const state of ['on', 'off'] as const)
        cards[`display_${state}`] = {
          title: `Turn the display ${state}`,
          lines: [
            `${screen.name}'s display turns ${state} now, whatever its display hours say, until its next scheduled display change, or ${OVERRIDE_LIMIT_MS / 3_600_000} hours at most, then follows its hours again.`,
          ],
          address: null,
          when: live,
          undo: 'Set it to follow its display hours again, or wait: it ends by itself.',
          press: `Turn ${state}`,
        };
      const card = cards[command];
      if (!card) throw new CardProblem(`${command} is not a screen command: identify, restart, display_on, display_off or display_auto`);
      return { input: { screenId: screen.id, command }, card };
    },
    run: run('screen_command'),
  },
  read_table: {
    tools: ['read_table'],
    input: ofRegistry('read_table'),
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
  save_data_source: {
    tools: ['save_data_source'],
    input: ofRegistry('save_data_source'),
    description: describedAs('save_data_source'),
    needsPublish: (called) => (called.dataSourceId === undefined ? called.format === 'provider' : reachesScreens(called)),
    async make(org, called) {
      // Refused now, not at the press, when the press could only be refused (#507).
      const refuse = (refused: ToolError | undefined) => {
        if (refused) throw new CardProblem(refused.message, { cause: refused });
      };
      const asked = saveDataSourceInput.parse(called);
      refuse(sourceRefusal(asked));
      if (called.dataSourceId === undefined) {
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
      }
      const source = await org.dataSources.get(str(called.dataSourceId));
      if (!source) throw new CardProblem(`no data source ${str(called.dataSourceId)}`);
      refuse(sourceRefusal(asked, source.format));
      return {
        input: { ...called, ifVersion: source.rowVersion },
        withheld: resourceLines(called),
        card: {
          title: 'Change a data source',
          lines: [
            `Changes ${source.name}: ${
              Object.keys(called)
                .filter((k) => !['dataSourceId', 'ifVersion', 'idempotencyKey'].includes(k))
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
    run: run('save_data_source'),
  },
  set_spot_url: {
    tools: ['save_spot'],
    input: () => z.object({ spotId: z.string().describe('The web page spot'), url: z.string().describe('The https address it shows') }).strict(),
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
    run: run('save_spot'),
  },
};

/** Whether `grant` may press `name`'s card for some input: it permits every tool the card runs. */
export const pressable = (grant: Grant, name: string) =>
  (CONFIRMABLE[name]?.tools ?? []).every((t) => {
    const tool = registry.get(t);
    return tool !== undefined && permits(grant, tool);
  });

/** Who may press the card: null when `grant` permits every tool it runs, else who to ask. */
export function whyNot(grant: Grant, name: string, needsPublish = false): string | null {
  const tools = (CONFIRMABLE[name]?.tools ?? []).flatMap((t) => registry.get(t) ?? []);
  if (needsPublish && !effectiveScopes(grant).includes('content:publish')) {
    return grant.role === 'editor' && !grant.editorsPublish
      ? 'Only owners publish in this organization, and this change needs the right to publish: ask an owner.'
      : 'You can view only: ask an editor.';
  }
  if (pressable(grant, name)) return null;
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
