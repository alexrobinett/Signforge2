/**
 * Publishing from the editors (canvas boards Spot editor A and Ideas 5-6): publish what is open,
 * undo it, roll back to an earlier publish, and choose the default playlist. The Schedule page
 * publishes its entries with the playlists and spots they need (M3-19).
 *
 * A publish from an editor saves the draft first, waiting for a save already on its way, then
 * publishes it pinned at the version saved (`publish` with `drafts`), so it publishes exactly what
 * the person sees and nobody else's unfinished drafts. A playlist publishes with its spots that have unpublished changes, since its
 * stage plays their saved drafts. The toast says what reached screens, with Undo (a roll back to
 * the publish before) and a link to the rollout. Confirmation dialogs are kept for revoking and
 * deleting: a publish is undone instead (docs/research/cms-ux.md). A publish that starts or ends a
 * takeover offers no Undo: a roll back would leave it published, to cut in again at the next
 * publish of anything; End now is the way back.
 */
import { toast } from 'sonner';
import type { ToolOutput } from '@signforge/tools/outputs';
import { problemWords } from '~/lib/field-words';
import type { PlaylistView } from '~/lib/playlists';
import type { ScheduleEntryView } from '~/lib/schedule';
import { versionName } from '~/lib/publishes';
import { sampleWords, type SpotView, versionsById } from '~/lib/spots';
import { orgOnScreen } from '~/lib/live';
import { callTool, isConflict, isStale, Refusal, sampleAcks, sampleTextOf, toolMessage, type SampleSpot } from '~/lib/tools';
import { overviewKey } from '~/lib/overview';
import { playlistKeys, playlistQuery, playlistsQuery } from '~/queries/playlists';
import { scheduleQuery } from '~/queries/schedule';
import { assetsQuery, brandKitsQuery, spotQuery, spotsQuery, templatesQuery } from '~/queries/spots';
import { changingOrg } from './orgs';
import type { SliceCreator } from './store';

interface Pin {
  kind: 'spot' | 'playlist' | 'schedule_entry';
  id: string;
  version: number;
}

interface PublishingState {
  /** A publish, roll back or default change is on its way. */
  pending: boolean;
  /**
   * A publish held to ask first (#360): spots in it still hold their template's sample text, as the
   * server records it (`sampleFields`). `answer` resolves the publish waiting on it: true for Publish
   * anyway, which sends it acknowledging exactly those spots, at those versions (`allowSample`); false
   * for Edit first or Escape, which change nothing.
   */
  sampleCheck: { words: string; spotId: string; answer: (publish: boolean) => void } | null;
  /** The sidebar's "Publish every unpublished change?" (#361), open while not null (`PublishAll`). */
  all: PublishAll | null;
}

/**
 * What the sidebar's Publish read and shows (#361): every draft with changes, pinned at the version
 * read, published exactly as shown, so an edit since makes the publish fail rather than go out
 * unseen, and a draft made since stays a draft. `pins` is null while reading, and empty when the
 * read finds nothing to publish, which is said and not offered. `tooMany`: more than one publish
 * takes, so none is offered. `noDefault`: with no default playlist yet, the playlist this publish
 * makes the default (`makes`), or null when it makes none and so changes no screen.
 */
export interface PublishAll {
  orgId: string;
  /** Which asking this is: a read answered for an asking cancelled, or replaced, is dropped. */
  asked: number;
  pins: Pin[] | null;
  counts: { spots: number; playlists: number; schedule: number };
  tooMany: boolean;
  noDefault: { makes: string | null } | null;
  /** A takeover goes with it: no Undo, as on the Schedule page. */
  takeover: boolean;
  /**
   * What it would change on screens (#187, `preview_publish`): which screens and why, and who joins or leaves each
   * group. Undefined while it is read; null when it could not be read, which the dialog does without.
   */
  preview?: PublishPreview | null;
}

export type PublishPreview = ToolOutput<'preview_publish'>;

/** The most drafts one publish pins (`publish`'s `drafts`, at most 500). */
export const MAX_PINS = 500;

/**
 * What a Schedule dialog showed the person of the default, and what they kept (#243, #336, #393).
 * `choice`: with no default, the one they chose to make it first, which is published with this if it
 * never was. `publishDefault`: with a default never published, they ticked to publish it too. Nothing
 * of the default goes with a publish unless the dialog showed it.
 */
interface DefaultChoice {
  choice?: string;
  publishDefault?: boolean;
}

export interface PublishingSlice {
  publishing: PublishingState;
  /** Saves the open spot's draft and publishes it; whether it was published. */
  publishSpot: (orgId: string, spotId: string) => Promise<boolean>;
  /** Saves the open playlist's draft and publishes it with its changed spots; whether it was published. */
  publishPlaylist: (orgId: string, playlistId: string) => Promise<boolean>;
  /** Points screens back at what `revision` gave them (`roll_back_publish`); an Undo names the publish it undoes, refused if a later one was made. */
  rollBackTo: (orgId: string, publish: { id: string; revision: number }, undoing?: string) => Promise<void>;
  /** Makes the playlist the one every screen plays when no schedule says otherwise. */
  makeDefaultPlaylist: (orgId: string, playlistId: string) => Promise<void>;
  /**
   * Publishes schedule entries (`entryIds`, else every one with a changed draft, removals too) with
   * their changed playlists and those playlists' changed spots. `withDefault`: from a dialog that
   * shows the default choice only (`DefaultChoice`). `acks`: the sample text the person already
   * said Publish anyway to (`checkSampleText`). Whether it was published.
   */
  publishSchedule: (orgId: string, entryIds?: string[], withDefault?: DefaultChoice, acks?: SampleSpot[]) => Promise<boolean>;
  /**
   * Publishes one schedule entry alone, pinned (#181): nobody else's drafts go with it. Its playlist
   * and that playlist's spots go too only when they have never been published, as the entry cannot
   * play without them; a published playlist's unpublished edits stay drafts. `withDefault`: from a
   * dialog that shows the default choice only (`DefaultChoice`). `acks` as `publishSchedule`'s.
   */
  publishEntry: (orgId: string, entryId: string, withDefault?: DefaultChoice, acks?: SampleSpot[]) => Promise<boolean>;
  /**
   * Publishes the agent's drafts in one publish, as each editor would (a playlist with its changed
   * spots, an entry with what it cannot play without), after one question about any sample text in
   * all of them: all of it reaches screens, or none. Whether it was published.
   */
  publishTogether: (orgId: string, items: readonly Pick<Pin, 'kind' | 'id'>[]) => Promise<boolean>;
  /** Ends a takeover now: deleted and published alone, in one call (`takeover`, action end). */
  endTakeover: (orgId: string, entryId: string) => Promise<void>;
  /** The held publish, sent with its sample text. */
  publishAnyway: () => void;
  /** The held publish let go, nothing changed, a schedule dialog closed, and the first spot with sample text opened to edit. */
  editFirst: () => Promise<void>;
  /** The held publish let go (Escape), nothing changed. */
  dropSampleCheck: () => void;
  /**
   * Before a schedule dialog saves the entry it publishes (#360): asks about sample text in what the
   * publish would pin, the entry's playlist (`alone` as `publishEntry` pins it, else as
   * `publishSchedule` does) and any default `withDefault` would publish, so Edit first leaves nothing
   * saved. The spots acknowledged (empty for none), or null for Edit first, Escape, or a failed read,
   * said under `refused`.
   */
  checkSampleText: (orgId: string, would: { playlistId: string; alone: boolean; withDefault: DefaultChoice; refused: string }) => Promise<SampleSpot[] | null>;
  /** Asks about the spots a `sample_text` refusal named, as ⌘K's tools are refused: true for Publish anyway. */
  askSampleText: (orgId: string, spots: [SampleSpot, ...SampleSpot[]]) => Promise<boolean>;
  /**
   * The sidebar's Publish pressed (#361): reads every draft with changes in `orgId` now and shows them
   * (`all`). Refused while the tab is switching org, or shows another.
   */
  askPublishAll: (orgId: string) => Promise<void>;
  /** Publishes exactly what `all` shows, at the versions read; whether it was published. */
  confirmPublishAll: () => Promise<boolean>;
  /** The sidebar's question let go, its read too if it is still on its way. */
  cancelPublishAll: () => void;
}

const TOAST_ID = 'publish';

/** A held draft's kinds, the one the others wait on first: a playlist waits on its spots, an entry on its playlist. */
const HELD_ORDER = ['spot', 'playlist', 'schedule_entry'] as const;

/** A record a held problem names by id ("brand kit bk_9 is not available"), as the publish checks word it. */
const MENTION = /\b(spot|playlist|brand kit|template version|asset) ([A-Za-z0-9_-]+)/g;
/** Those that belong to the draft itself: unnamed, "its brand kit"; another draft is "a spot". */
const OWN = new Set(['brand kit', 'template version', 'asset']);

const screensWord = (n: number) => (n === 1 ? '1 screen' : `${n} screens`);

/**
 * Whether an entry plays on every screen at all hours, always, exactly as the server's
 * `everywhereAlways` (packages/tools/src/publishing.ts) decides it: every day is no days or all
 * seven, once each, and a takeover's times rule it out.
 */
const playsEverywhereAlways = (e: ScheduleEntryView) =>
  e.target === 'org' &&
  (e.days === null || new Set(e.days).size === 7) &&
  !e.from &&
  !e.to &&
  !e.startDate &&
  !e.endDate &&
  e.startsAt === null &&
  e.endsAt === null;

/**
 * With no default playlist yet, what a publish of `entries` does about it, as the server decides
 * (#243, `firstDefault`): when the entries it makes live that play on every screen at all hours all
 * play one playlist, that becomes the default. Otherwise no screen can be compiled, so none
 * changes until there is a default. Null when there is one.
 */
function noDefaultOf(playlists: readonly PlaylistView[], entries: readonly ScheduleEntryView[]): PublishAll['noDefault'] {
  if (playlists.some((p) => p.isDefault)) return null;
  const ids = new Set(entries.filter((e) => !e.deleted && playsEverywhereAlways(e)).map((e) => e.playlistId));
  const only = ids.size === 1 ? playlists.find((p) => ids.has(p.id)) : undefined;
  return { makes: only?.name ?? null };
}

export const createPublishingSlice: SliceCreator<PublishingSlice> = (set, get, { queryClient, router }) => {
  const pending = (on: boolean) => set((s) => ({ publishing: { ...s.publishing, pending: on } }));
  const showAll = (all: PublishAll | null) => set((s) => ({ publishing: { ...s.publishing, all } }));
  /** The sidebar's askings so far: each read belongs to one. */
  let asked = 0;
  /** Whether the tab shows `orgId`, with no switch or create of its own on the way: what the sidebar's publish needs (#361). */
  const showing = (orgId: string) => !changingOrg(get().orgs) && orgOnScreen(router) === orgId;
  /** Everything a publish can change: drafts' published state, playlists, screens and the rollout. */
  const refresh = (orgId: string) => queryClient.invalidateQueries({ queryKey: ['org', orgId] });
  const viewRollout = (id: string) => ({ label: 'View rollout', onClick: () => void router.navigate({ to: '/publishes', search: { id } }) });

  /**
   * Why a publish was held back, in names (#253): the draft the others wait on (a spot before its
   * playlist, a playlist before its entry), its first problem with each id named, and a way to open
   * it. Names come from the lists already read, else a read now, never retried: someone is waiting
   * on the toast. A name that cannot be read is said in plain words ("its brand kit"), never an id.
   */
  async function heldWords(orgId: string, held: ToolOutput<'publish'>['held']) {
    const root = HELD_ORDER.flatMap((kind) => held.filter((h) => h.kind === kind))[0];
    if (!root) return undefined;
    const problem = (root.problems[0] ?? '').replace(new RegExp(`^${root.kind} ${root.id}: `), '').replace(/^brand: /, '');
    const mentioned = new Set([root.kind, ...[...problem.matchAll(MENTION)].map((m) => m[1])]);
    const once = { staleTime: Number.POSITIVE_INFINITY, retry: false } as const;
    const none = () => undefined;
    // A spot's field's problem, said with the field's label, as its editor says it (#359).
    const field = root.kind === 'spot' && /^(?:image )?field "/.test(problem);
    const [spots, playlists, templates, kits, assets] = await Promise.all([
      mentioned.has('spot') ? queryClient.query({ ...spotsQuery(orgId), ...once }).catch(none) : undefined,
      mentioned.has('playlist') ? queryClient.query({ ...playlistsQuery(orgId), ...once }).catch(none) : undefined,
      mentioned.has('template version') || field ? queryClient.query({ ...templatesQuery(orgId), ...once }).catch(none) : undefined,
      mentioned.has('brand kit') ? queryClient.query({ ...brandKitsQuery(orgId), ...once }).catch(none) : undefined,
      mentioned.has('asset') ? queryClient.query({ ...assetsQuery(orgId), ...once }).catch(none) : undefined,
    ]);
    const versions = versionsById(templates?.templates ?? []);
    const names = new Map<string, string>([
      ...[...(spots?.spots ?? []), ...(playlists?.playlists ?? []), ...(kits?.brandKits ?? []), ...(assets?.assets ?? [])].map((x) => [x.id, x.name] as const),
      ...(templates?.templates ?? []).flatMap((t) => t.versions.map((v) => [v.id, `${t.name} ${v.version}`] as const)),
    ]);
    const named = problem.replace(MENTION, (_all, kind: string, id: string) => names.get(id) ?? `${OWN.has(kind) ? 'its' : 'a'} ${kind}`);
    const name = root.kind === 'schedule_entry' ? 'The schedule entry' : (names.get(root.id) ?? `This ${root.kind}`);
    const open =
      root.kind === 'spot'
        ? () => router.navigate({ to: '/spots/$spotId', params: { spotId: root.id } })
        : root.kind === 'playlist'
          ? () => router.navigate({ to: '/playlists/$playlistId', params: { playlistId: root.id } })
          : () => router.navigate({ to: '/schedule' });
    const action = { label: root.kind === 'schedule_entry' ? 'Open the schedule' : `Open ${name}`, onClick: () => void open() };
    if (field) {
      const version = spots?.spots.find((s) => s.id === root.id)?.templateVersionId;
      const words = problemWords(problem, (version && versions.get(version)?.manifest.fields) || {});
      return {
        text: words.startsWith('No image') ? `${name} has ${words.charAt(0).toLowerCase()}${words.slice(1)}.` : `${name} does not pass its checks: ${words}.`,
        action,
      };
    }
    return { text: `${name} does not pass its checks: ${named}.`, action };
  }

  /**
   * The toast for a publish's answer: what reached screens, else why nothing did; with Undo unless
   * `undo` is false. `refused` titles a publish that was held back, as it does a refused one;
   * `setDefault` names a default set on the way, which stays set though nothing is published.
   */
  async function told(orgId: string, r: ToolOutput<'publish'>, undo = true, refused = 'Not published', setDefault?: string) {
    const held = await heldWords(orgId, r.held);
    const noDefault = r.screens.some((s) => s.problems.includes('the organization has no default playlist'));
    // Every screen refused it: say the screens' own reason, not a guess.
    const allFailed = r.screens.length > 0 && r.screens.every((s) => s.outcome === 'failed');
    const failure = r.screens.flatMap((s) => s.problems)[0];
    const reachesNone = noDefault
      ? 'No screen can play anything yet: choose a default playlist, with Play on every screen on a playlist.'
      : allFailed && failure
        ? `Every screen keeps what it plays: ${failure}.`
        : r.screens.length
          ? 'No screen plays it yet: add it to a playlist that screens play.'
          : 'No screen is paired yet.';
    if (!r.publish) {
      // A default set on the way stays set, though nothing is published (#336).
      const stays = setDefault ? `${setDefault} is now the default playlist. ` : '';
      if (held) toast.error(refused, { description: `${stays}${held.text}`, action: held.action, duration: 10_000 });
      else if (noDefault || allFailed) toast.error('No screen can play it yet', { description: `${stays}${reachesNone}` });
      else toast('Nothing to publish', { description: `${stays}Every screen already plays this.` });
      return;
    }
    const made = r.publish;
    const v = versionName(made);
    const failed = r.screens.filter((s) => s.outcome === 'failed').length;
    // Named by the publish's answer, as published (#243).
    const madeDefault = r.madeDefault && `${r.madeDefault.name} is now the default playlist: every screen plays it when nothing is scheduled.`;
    const notes = [
      madeDefault,
      made.screens ? 'Each screen switches as it hears of it; the rollout says why any wait.' : reachesNone,
      held && `Held back: ${held.text}`,
      made.screens > 0 && failed > 0 && `${screensWord(failed)} could not take it and keep what they play.`,
    ].filter(Boolean);
    const previous = made.previousId;
    toast.success(made.screens ? `Published ${v} to ${screensWord(made.screens)}` : `Published ${v}`, {
      description: notes.join(' '),
      // Always set: this toast replaces the last one, and an action left out would keep that one's Undo.
      action:
        undo && previous && made.screens
          ? { label: 'Undo', onClick: () => void get().rollBackTo(orgId, { id: previous, revision: made.revision - 1 }, made.id) }
          : undefined,
      cancel: viewRollout(made.id),
      duration: 10_000,
      // One publish toast at a time: the next replaces it.
      id: TOAST_ID,
    });
  }

  /**
   * The schedule, playlists and spots, read now, not from the cache: a draft edited in another tab,
   * or an entry just saved, is pinned at its version now. Null when the read fails, said under `refused`.
   */
  async function readDrafts(orgId: string, refused: string) {
    try {
      const [{ entries }, { playlists }, { spots }] = await Promise.all([
        queryClient.query({ ...scheduleQuery(orgId), staleTime: 0 }),
        queryClient.query({ ...playlistsQuery(orgId), staleTime: 0 }),
        queryClient.query({ ...spotsQuery(orgId), staleTime: 0 }),
      ]);
      return { entries, playlists, spots };
    } catch (err) {
      toast.error(refused, { description: toolMessage(err) });
      return null;
    }
  }

  /**
   * What a publish from the Schedule's dialogs (#243), which show the default choice and alone pass
   * `withDefault`, does with the default; any other publish pins nothing of it. With no default
   * playlist yet, the one the person chose is to be made the default first (`set`, by `setDefault`,
   * after any question about sample text, #360). If that default was never published, its pins and
   * its unpublished spots', so the publish publishes it. With a default already, the dialog offered no
   * choice: one never published is pinned only when the person ticked its own box (`publishDefault`),
   * as a retry after a publish that failed once the default was set would (#336, #393). Pinned, the
   * publish carries `ifDefault`, which refuses it if it is no longer the default by then. `made` names
   * the default this sets, for the toasts. Reads only: nothing is written here.
   */
  function defaultPlan(
    withDefault: DefaultChoice | undefined,
    drafts: { playlists: PlaylistView[]; spots: SpotView[] },
  ): { set?: PlaylistView; pins: Pin[]; made?: string; ifDefault?: string } {
    // Not from a dialog that shows the default: no pin the person did not see (round 3 of #393).
    if (!withDefault) return { pins: [] };
    const { choice, publishDefault } = withDefault;
    const current = drafts.playlists.find((p) => p.isDefault);
    // A default already: the dialog offered no choice, so only its own box publishes it with this (#393).
    if (current && !publishDefault) return { pins: [] };
    const set = current ? undefined : choice ? drafts.playlists.find((p) => p.id === choice) : undefined;
    const target = current ?? set;
    if (!target) return { pins: [] };
    if (target.published) return { set, pins: [], made: set?.name };
    const inIt = new Set(target.spotIds);
    return {
      set,
      made: set?.name,
      ifDefault: target.id,
      pins: [
        { kind: 'playlist', id: target.id, version: target.version },
        ...drafts.spots.filter((s) => inIt.has(s.id) && !s.published).map((s): Pin => ({ kind: 'spot', id: s.id, version: s.version })),
      ],
    };
  }

  /**
   * Makes the chosen playlist the default (`set_default_playlist` with `ifDefault: null`: only while
   * the org has none, checked again as it is saved, so a default someone chose meanwhile is never
   * replaced). False when refused, which is said under `refused`.
   */
  async function setDefault(playlistId: string, refused: string) {
    try {
      await callTool('set_default_playlist', { playlistId, ifDefault: null });
      return true;
    } catch (err) {
      toast.error(refused, {
        description: isConflict(err) ? 'Someone chose a default playlist meanwhile. Reload to see it, then publish again.' : toolMessage(err),
      });
      return false;
    }
  }

  /** The pinned spots a publish would promote that still hold sample text, as read now (`sampleFields`). */
  const sampleIn = (spots: readonly SpotView[], pins: readonly Pin[]): SampleSpot[] =>
    spots.flatMap((s) =>
      s.sampleFields && s.draftChanged && pins.some((p) => p.kind === 'spot' && p.id === s.id)
        ? [{ id: s.id, name: s.name, version: s.version, fields: [...s.sampleFields.texts, ...Object.keys(s.sampleFields.lists)] }]
        : [],
    );

  /**
   * Asks about the `spots` that `acks` does not cover (the same spot, version and fields), and gives
   * the acknowledgement to publish with: `acks` with them for Publish anyway, null for Edit first or Escape.
   */
  async function acknowledge(orgId: string, spots: readonly SampleSpot[], acks: SampleSpot[]): Promise<SampleSpot[] | null> {
    const [first, ...more] = spots.filter((s) => !acks.some((a) => a.id === s.id && a.version === s.version && s.fields.every((f) => a.fields.includes(f))));
    if (!first) return acks;
    return (await ask(orgId, [first, ...more])) ? [...acks, first, ...more] : null;
  }

  /**
   * What an entry for `playlistId` pins besides itself. `alone` (`publishEntry`, #181): its playlist and
   * that playlist's spots only while the playlist was never published, as the entry cannot play
   * without them. Otherwise (`publishSchedule`): the playlist's and its spots' unpublished changes.
   */
  function playlistPins(drafts: { playlists: PlaylistView[]; spots: SpotView[] }, playlistId: string, alone: boolean): Pin[] {
    const playlist = drafts.playlists.find((p) => p.id === playlistId);
    if (!playlist || (alone && playlist.published)) return [];
    const due = (d: { published: boolean; draftChanged: boolean }) => (alone ? !d.published : d.draftChanged);
    const inIt = new Set(playlist.spotIds);
    return [
      ...(due(playlist) ? [{ kind: 'playlist', id: playlist.id, version: playlist.version } satisfies Pin] : []),
      ...drafts.spots.filter((s) => inIt.has(s.id) && due(s)).map((s): Pin => ({ kind: 'spot', id: s.id, version: s.version })),
    ];
  }

  /**
   * Asks about the spots' sample text (#360), naming each field by its label, and resolves with the
   * answer: true for Publish anyway. Labels come from the templates as the pages read them; a field
   * whose template cannot be read is named as it is.
   */
  async function ask(orgId: string, spots: [SampleSpot, ...SampleSpot[]]) {
    const once = { staleTime: Number.POSITIVE_INFINITY, retry: false } as const;
    const none = () => undefined;
    const [templates, list] = await Promise.all([
      queryClient.query({ ...templatesQuery(orgId), ...once }).catch(none),
      queryClient.query({ ...spotsQuery(orgId), ...once }).catch(none),
    ]);
    // Left meanwhile (the org changed): no question opens over the next org, and nothing of this one goes live (review of #472).
    if (!showing(orgId)) return false;
    const versions = versionsById(templates?.templates ?? []);
    const words = sampleWords(
      spots.map((s) => {
        const v = list?.spots.find((x) => x.id === s.id)?.templateVersionId;
        const fields = (v && versions.get(v)?.manifest.fields) || {};
        return { name: s.name, labels: s.fields.map((f) => fields[f]?.label ?? f) };
      }),
    );
    return new Promise<boolean>((answer) => set((s) => ({ publishing: { ...s.publishing, sampleCheck: { words, spotId: spots[0].id, answer } } })));
  }

  /** The question let go with `publish`: the publish waiting on it goes on, or stops. */
  function answer(publish: boolean) {
    const check = get().publishing.sampleCheck;
    if (!check) return undefined;
    set((s) => ({ publishing: { ...s.publishing, sampleCheck: null } }));
    check.answer(publish);
    return check;
  }

  /**
   * Publishes `pins` with the default `withDefault` plans. It first asks about sample text in all that
   * would go live that `acks` does not cover, before a default is set (#360): Edit first then leaves
   * everything as it was, the default included. The server's refusal still asks about any it finds
   * since (`publish`).
   */
  async function withDefaultSet(
    orgId: string,
    drafts: { playlists: PlaylistView[]; spots: SpotView[] },
    withDefault: DefaultChoice | undefined,
    pins: Pin[],
    refused: string,
    acks: SampleSpot[],
    send: (pins: Pin[], byDefault: { made?: string; ifDefault?: string }, acks: SampleSpot[]) => Promise<boolean>,
  ) {
    const plan = defaultPlan(withDefault, drafts);
    const all = [...pins, ...plan.pins];
    const allowed = await acknowledge(orgId, sampleIn(drafts.spots, all), acks);
    if (!allowed) return false;
    if (plan.set && !(await setDefault(plan.set.id, refused))) return false;
    return send(all, { made: plan.made, ifDefault: plan.ifDefault }, allowed);
  }

  /**
   * Publishes `pins`; `refused` titles a refusal, as `told` does a publish held back. `byDefault` is
   * what `defaultPlan` gave: the default set on the way, which a refusal or a held publish says, as it
   * stays set, and the default its pins are published only while it is (`ifDefault`); `ifScreens`, the screens a
   * publish of no draft showed it would change, which it changes exactly or is refused (#187). `acks`: the
   * sample text the person said Publish anyway to, sent as `allowSample`. Refused for sample text it
   * does not cover (#360), it asks about those, and with Publish anyway sends it again acknowledging
   * them too. Whether it was published.
   */
  async function publish(
    orgId: string,
    pins: Pin[],
    undo = true,
    refused = 'Not published',
    byDefault: { made?: string; ifDefault?: string; ifScreens?: string[] } = {},
    acks: SampleSpot[] = [],
  ): Promise<boolean> {
    const { made, ifDefault, ifScreens } = byDefault;
    // Asked in an org the tab has left, or is leaving (a drawer's Publish answered late): it is not sent (#479), and
    // said, as the sidebar's Publish says it (#495).
    if (!showing(orgId)) {
      toast.error(refused, { description: 'The organization is changing. Publish once it shows.' });
      return false;
    }
    pending(true);
    try {
      // Once each: a chosen default may be the entry's own playlist.
      const drafts = [...new Map(pins.map((p) => [`${p.kind}:${p.id}`, p])).values()];
      const allowSample = acks.length ? { allowSample: sampleAcks(acks) } : {};
      // Named: the org the pins were read in, not the one a switch is taking the tab to (#361).
      const r = await callTool('publish', { drafts, ...(ifDefault ? { ifDefault } : {}), ...(ifScreens ? { ifScreens } : {}), ...allowSample }, orgId);
      await told(orgId, r, undo, refused, made);
      await refresh(orgId);
      // Held back, or nothing to publish: no publish was made, which the toast says.
      return r.publish !== null;
    } catch (err) {
      const sample = sampleTextOf(err);
      if (sample?.length) {
        pending(false);
        const next = await acknowledge(orgId, sample, acks);
        if (!next) return false;
        // Only spots it did not cover: once more, with them. One it did would be refused for good, said below.
        if (next.length > acks.length) return publish(orgId, pins, undo, refused, byDefault, next);
      }
      const details = err instanceof Refusal && err.code === 'conflict' && typeof err.details === 'object' && err.details !== null ? err.details : undefined;
      // A conflict naming one of its pins: that draft changed since it was read.
      const pinned = details !== undefined && 'id' in details && pins.some((p) => p.id === details.id);
      // `ifDefault` refused: the default the pins were for is no longer it, the one this set included.
      if (details && 'defaultPlaylistId' in details) toast.error(refused, { description: 'Someone changed the default playlist. Reload to see it.' });
      // `ifScreens` refused: the screens it would change are not the ones the question showed (review of #621).
      else if (ifScreens && details && 'screens' in details)
        toast.error(refused, { description: 'Which screens it would change has changed since you were shown. Press Publish again to see them.' });
      // Any other conflict (the publish lost its race until it gave up): what changed is not known, nor whether a default set is still it.
      else if (details && !pinned) toast.error(refused, { description: 'Something changed while publishing. Reload and try again.' });
      else {
        const why = pinned && isStale(err) ? 'It changed since you opened it, perhaps in another tab. Reload and publish again.' : toolMessage(err);
        toast.error(refused, { description: made ? `${made} is now the default playlist. ${why}` : why });
      }
      return false;
    } finally {
      pending(false);
    }
  }

  return {
    publishing: { pending: false, sampleCheck: null, all: null },

    async askPublishAll(orgId) {
      if (!showing(orgId)) {
        toast.error('Not published', { description: 'The organization is changing. Publish once it shows.' });
        return;
      }
      const mine = ++asked;
      showAll({ orgId, asked: mine, pins: null, counts: { spots: 0, playlists: 0, schedule: 0 }, tooMany: false, noDefault: null, takeover: false });
      // Read beside the drafts, so the dialog shows what it would change on screens with what it publishes (#187).
      const [drafts, preview] = await Promise.all([readDrafts(orgId, 'Not published'), callTool('preview_publish', {}, orgId).catch(() => null)]);
      // Cancelled, or asked again, meanwhile: this read is no one's.
      if (get().publishing.all?.asked !== mine) return;
      if (!drafts || !showing(orgId)) {
        showAll(null);
        return;
      }
      const spots = drafts.spots.filter((x) => x.draftChanged);
      const playlists = drafts.playlists.filter((x) => x.draftChanged);
      const entries = drafts.entries.filter((x) => x.draftChanged);
      const pins = [
        ...spots.map((x): Pin => ({ kind: 'spot', id: x.id, version: x.version })),
        ...playlists.map((x): Pin => ({ kind: 'playlist', id: x.id, version: x.version })),
        ...entries.map((x): Pin => ({ kind: 'schedule_entry', id: x.id, version: x.version })),
      ];
      showAll({
        orgId,
        asked: mine,
        pins,
        counts: { spots: spots.length, playlists: playlists.length, schedule: entries.length },
        tooMany: pins.length > MAX_PINS,
        noDefault: noDefaultOf(drafts.playlists, entries),
        takeover: entries.some((e) => e.takeover),
        preview,
      });
      // Nothing to publish after all: the counts were behind, so they are read again.
      if (!pins.length) void queryClient.invalidateQueries({ queryKey: overviewKey(orgId) });
    },

    async confirmPublishAll() {
      const all = get().publishing.all;
      // Never an empty publish for nothing: `drafts: []` only when the preview says screens would change, as labels moved
      // a smart group's members since the last publish (#187).
      if (!all?.pins || all.tooMany || (!all.pins.length && !all.preview?.screens.length)) return false;
      showAll(null);
      if (!showing(all.orgId)) {
        toast.error('Not published', { description: 'The organization is changing. Publish once it shows.' });
        return false;
      }
      // Exactly what was shown, at the versions read: one edited since refuses it as changed. Sample text asks as any publish does (#360).
      // With no draft, it publishes only to the screens the preview showed: any other set is refused, not sent (review of #621).
      if (!all.pins.length && all.preview)
        return publish(all.orgId, [], !all.takeover, 'Not published', { ifScreens: all.preview.screens.map((s) => s.screenId) });
      return publish(all.orgId, all.pins, !all.takeover);
    },

    cancelPublishAll: () => showAll(null),

    publishAnyway: () => void answer(true),

    dropSampleCheck: () => void answer(false),

    async editFirst() {
      const check = answer(false);
      if (!check) return;
      // A schedule dialog asked before it saved: it goes too, so nothing is left behind.
      get().closeScheduleDialog();
      await router.navigate({ to: '/spots/$spotId', params: { spotId: check.spotId } });
    },

    askSampleText: (orgId, spots) => ask(orgId, spots),

    async checkSampleText(orgId, { playlistId, alone, withDefault, refused }) {
      // Pending from the first click: a second, while this reads or asks, starts nothing.
      if (get().publishing.pending) return null;
      pending(true);
      try {
        const drafts = await readDrafts(orgId, refused);
        if (!drafts) return null;
        const pins = [...playlistPins(drafts, playlistId, alone), ...defaultPlan(withDefault, drafts).pins];
        return await acknowledge(orgId, sampleIn(drafts.spots, pins), []);
      } finally {
        pending(false);
      }
    },

    async publishSpot(orgId, spotId) {
      await get().saveSpotDraft(spotId);
      const d = get().spotEditor.drafts[spotId];
      const spot = queryClient.getQueryData(spotQuery(orgId, spotId).queryKey);
      if (!spot || (d?.orgId === orgId && d.status !== 'saved')) {
        toast.error('Not published', { description: 'Save the draft first: fix what is marked, then publish.' });
        return false;
      }
      return publish(orgId, [{ kind: 'spot', id: spot.id, version: spot.version }]);
    },

    async publishPlaylist(orgId, playlistId) {
      await get().savePlaylistDraft(playlistId);
      const d = get().playlistEditor.drafts[playlistId];
      const playlist = queryClient.getQueryData(playlistQuery(orgId, playlistId).queryKey);
      if (!playlist || (d?.orgId === orgId && d.status !== 'saved')) {
        toast.error('Not published', { description: 'Save the draft first: fix what is marked, then publish.' });
        return false;
      }
      // Read now, not from the cache: a spot edited in another tab is pinned at its version now.
      const spots = (await queryClient.query({ ...spotsQuery(orgId), staleTime: 0 })).spots;
      const inIt = new Set(playlist.spotIds);
      const changed = spots.filter((s) => inIt.has(s.id) && s.draftChanged).map((s): Pin => ({ kind: 'spot', id: s.id, version: s.version }));
      return publish(orgId, [{ kind: 'playlist', id: playlist.id, version: playlist.version }, ...changed]);
    },

    async rollBackTo(orgId, target, undoing) {
      pending(true);
      try {
        const made = (await callTool('roll_back_publish', { publishId: target.id, ...(undoing ? { ifLatest: undoing } : {}) })).publish;
        const v = versionName(target);
        // A new toast, not the publish toast updated: that one's Undo would go along with it.
        toast.dismiss(TOAST_ID);
        if (!made) toast('Nothing to roll back', { description: `Every screen already has what ${v} gave it.` });
        else
          toast.success(`Screens pointed back at ${v}`, {
            description: 'Nothing was rebuilt or deleted: the newer publishes stay in the history. Your next Publish replaces this with what is published now.',
            cancel: viewRollout(made.id),
            duration: 10_000,
          });
        await refresh(orgId);
      } catch (err) {
        toast.error(undoing && isConflict(err) ? 'Not undone' : 'Not rolled back', {
          description:
            undoing && isConflict(err)
              ? 'Someone published since, and an undo would take theirs back too. Roll back from Publishes if you mean to.'
              : toolMessage(err),
        });
      } finally {
        pending(false);
      }
    },

    async publishSchedule(orgId, entryIds, withDefault, acks = []) {
      const drafts = await readDrafts(orgId, 'Not published');
      if (!drafts) return false;
      const { entries, playlists, spots } = drafts;
      // Before a default is set or anything pinned: an entry asked for that is gone (removed in another tab) publishes nothing.
      if (entryIds?.some((id) => !entries.some((e) => e.id === id))) {
        toast.error('Not published', { description: 'An entry is no longer there: someone may have removed it. Reload and look again.' });
        return false;
      }
      const chosen = entries.filter((e) => (entryIds ? entryIds.includes(e.id) : e.draftChanged));
      const needed = new Set(chosen.filter((e) => !e.deleted).map((e) => e.playlistId));
      const pins = [
        ...chosen.map((e): Pin => ({ kind: 'schedule_entry', id: e.id, version: e.version })),
        ...[...needed].flatMap((id) => playlistPins({ playlists, spots }, id, false)),
      ];
      return withDefaultSet(orgId, drafts, withDefault, pins, 'Not published', acks, (all, byDefault, allowed) =>
        publish(orgId, all, !chosen.some((e) => e.takeover), 'Not published', byDefault, allowed),
      );
    },

    async publishEntry(orgId, entryId, withDefault, acks = []) {
      // Called once the entry is saved: every way this ends without a publish says the draft is kept.
      const refused = 'Saved as a draft, not published';
      const drafts = await readDrafts(orgId, refused);
      if (!drafts) return false;
      const entry = drafts.entries.find((e) => e.id === entryId);
      if (!entry) {
        // Gone, so not saved as a draft either.
        toast.error('Not published', { description: 'The entry is no longer there: someone may have removed it.' });
        return false;
      }
      // After the entry is found: a default is set only for a publish that will run.
      const pins = [{ kind: 'schedule_entry', id: entry.id, version: entry.version } satisfies Pin, ...playlistPins(drafts, entry.playlistId, true)];
      return withDefaultSet(orgId, drafts, withDefault, pins, refused, acks, (all, byDefault, allowed) =>
        publish(orgId, all, true, refused, byDefault, allowed),
      );
    },

    async publishTogether(orgId, items) {
      // An editor open on one of them has its unsaved edits saved first, as its own Publish does.
      for (const item of items) {
        if (item.kind === 'schedule_entry') continue;
        if (item.kind === 'spot') await get().saveSpotDraft(item.id);
        else await get().savePlaylistDraft(item.id);
        const d = item.kind === 'spot' ? get().spotEditor.drafts[item.id] : get().playlistEditor.drafts[item.id];
        if (d?.orgId === orgId && d.status !== 'saved') {
          toast.error('Not published', { description: 'Save the draft first: fix what is marked, then publish.' });
          return false;
        }
      }
      const drafts = await readDrafts(orgId, 'Not published');
      if (!drafts) return false;
      const pins: Pin[] = [];
      for (const { kind, id } of items) {
        const row =
          kind === 'spot'
            ? drafts.spots.find((s) => s.id === id)
            : kind === 'playlist'
              ? drafts.playlists.find((p) => p.id === id)
              : drafts.entries.find((e) => e.id === id);
        if (!row) {
          toast.error('Not published', { description: 'A draft is no longer there: someone may have removed it. Nothing was published.' });
          return false;
        }
        pins.push({ kind, id, version: row.version });
        if ('spotIds' in row) pins.push(...playlistPins(drafts, row.id, false).filter((p) => p.kind === 'spot'));
        if ('playlistId' in row) pins.push(...playlistPins(drafts, row.playlistId, true));
      }
      const takeover = drafts.entries.some((e) => e.takeover && items.some((i) => i.id === e.id));
      return withDefaultSet(orgId, drafts, undefined, pins, 'Not published', [], (all, byDefault, allowed) =>
        publish(orgId, all, !takeover, 'Not published', byDefault, allowed),
      );
    },

    async endTakeover(orgId, entryId) {
      pending(true);
      try {
        await told(orgId, await callTool('takeover', { action: 'end', scheduleEntryId: entryId }), false);
        await refresh(orgId);
      } catch (err) {
        toast.error('Not ended', { description: toolMessage(err) });
      } finally {
        pending(false);
      }
    },

    async makeDefaultPlaylist(orgId, playlistId) {
      pending(true);
      try {
        const playlist = (await callTool('set_default_playlist', { playlistId })).playlist;
        queryClient.setQueryData(playlistKeys.one(orgId, playlistId), playlist);
        await queryClient.invalidateQueries({ queryKey: playlistKeys.all(orgId), exact: true });
        void queryClient.invalidateQueries({ queryKey: overviewKey(orgId) });
        toast.success(`${playlist.name} plays on every screen`, { description: 'From the next publish, wherever no schedule says otherwise.' });
      } catch (err) {
        toast.error('Not changed', { description: toolMessage(err) });
      } finally {
        pending(false);
      }
    },
  };
};
