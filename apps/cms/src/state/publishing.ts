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
import { versionName } from '~/lib/publishes';
import { sampleWords, type SpotView, versionsById } from '~/lib/spots';
import { callTool, isConflict, isStale, Refusal, sampleTextOf, toolMessage, type SampleSpot } from '~/lib/tools';
import { overviewKey } from '~/lib/overview';
import { playlistKeys, playlistQuery, playlistsQuery } from '~/queries/playlists';
import { scheduleQuery } from '~/queries/schedule';
import { assetsQuery, brandKitsQuery, spotQuery, spotsQuery, templatesQuery } from '~/queries/spots';
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
   * anyway, which sends it again with `allowSample`; false for Edit first or Escape, which change nothing.
   */
  sampleCheck: { words: string; spotId: string; answer: (publish: boolean) => void } | null;
}

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
   * their changed playlists and those playlists' changed spots.
   */
  /**
   * `withDefault`: from a dialog that shows the default choice only (`DefaultChoice`); asked about
   * sample text before a default is set, so Edit first changes nothing (#360). `allowSample`: the
   * person already said Publish anyway. Whether it was published.
   */
  publishSchedule: (orgId: string, entryIds?: string[], withDefault?: DefaultChoice, allowSample?: boolean) => Promise<boolean>;
  /**
   * Publishes one schedule entry alone, pinned (#181): nobody else's drafts go with it. Its playlist
   * and that playlist's spots go too only when they have never been published, as the entry cannot
   * play without them; a published playlist's unpublished edits stay drafts. `withDefault`: from a
   * dialog that shows the default choice only (`DefaultChoice`); the agent's drawer never passes it.
   */
  publishEntry: (orgId: string, entryId: string, withDefault?: DefaultChoice) => Promise<boolean>;
  /** Ends a takeover now: deleted and published alone, in one call (`end_takeover`). */
  endTakeover: (orgId: string, entryId: string) => Promise<void>;
  /** The held publish, sent with its sample text. */
  publishAnyway: () => void;
  /** The held publish let go, nothing changed, and the first spot with sample text opened to edit. */
  editFirst: () => Promise<void>;
  /** The held publish let go (Escape), nothing changed. */
  dropSampleCheck: () => void;
  /**
   * Before a takeover is started (#360): asks if the playlist's spots still hold sample text, so Edit
   * first leaves nothing made. `none` when none does; `allowed` for Publish anyway; `cancelled` otherwise.
   */
  checkSampleText: (orgId: string, playlistId: string) => Promise<'none' | 'allowed' | 'cancelled'>;
  /** Asks about the spots a `sample_text` refusal named, as ⌘K's tools are refused: true for Publish anyway. */
  askSampleText: (orgId: string, spots: [SampleSpot, ...SampleSpot[]]) => Promise<boolean>;
}

const TOAST_ID = 'publish';

/** A held draft's kinds, the one the others wait on first: a playlist waits on its spots, an entry on its playlist. */
const HELD_ORDER = ['spot', 'playlist', 'schedule_entry'] as const;

/** A record a held problem names by id ("brand kit bk_9 is not available"), as the publish checks word it. */
const MENTION = /\b(spot|playlist|brand kit|template version|asset) ([A-Za-z0-9_-]+)/g;
/** Those that belong to the draft itself: unnamed, "its brand kit"; another draft is "a spot". */
const OWN = new Set(['brand kit', 'template version', 'asset']);

const screensWord = (n: number) => (n === 1 ? '1 screen' : `${n} screens`);

export const createPublishingSlice: SliceCreator<PublishingSlice> = (set, get, { queryClient, router }) => {
  const pending = (on: boolean) => set((s) => ({ publishing: { ...s.publishing, pending: on } }));
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

  /** The pinned spots that still hold sample text, as read now (`sampleFields`). */
  const sampleIn = (spots: readonly SpotView[], pins: readonly Pin[]): SampleSpot[] =>
    spots.flatMap((s) =>
      s.sampleFields && pins.some((p) => p.kind === 'spot' && p.id === s.id)
        ? [{ id: s.id, name: s.name, fields: [...s.sampleFields.texts, ...Object.keys(s.sampleFields.lists)] }]
        : [],
    );

  /**
   * Asks about the spots' sample text (#360), naming each field by its label, and resolves with the
   * answer: true for Publish anyway. Labels come from the templates as the pages read them; a field
   * whose template cannot be read is named as it is.
   */
  async function ask(orgId: string, spots: [SampleSpot, ...SampleSpot[]], named: boolean) {
    const once = { staleTime: Number.POSITIVE_INFINITY, retry: false } as const;
    const none = () => undefined;
    const [templates, list] = await Promise.all([
      queryClient.query({ ...templatesQuery(orgId), ...once }).catch(none),
      queryClient.query({ ...spotsQuery(orgId), ...once }).catch(none),
    ]);
    const versions = versionsById(templates?.templates ?? []);
    const words = sampleWords(
      spots.map((s) => {
        const v = list?.spots.find((x) => x.id === s.id)?.templateVersionId;
        const fields = (v && versions.get(v)?.manifest.fields) || {};
        return { name: s.name, labels: s.fields.map((f) => fields[f]?.label ?? f) };
      }),
      named,
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
   * Publishes `pins` with the default `withDefault` plans. When a default is to be set first, it asks
   * about sample text in all that would go live before setting it (#360): Edit first then leaves
   * everything as it was, the default included. Otherwise the server's refusal asks (`publish`).
   */
  async function withDefaultSet(
    orgId: string,
    drafts: { playlists: PlaylistView[]; spots: SpotView[] },
    withDefault: DefaultChoice | undefined,
    pins: Pin[],
    refused: string,
    allowSample: boolean,
    send: (pins: Pin[], byDefault: { made?: string; ifDefault?: string }, allowSample: boolean) => Promise<boolean>,
  ) {
    const plan = defaultPlan(withDefault, drafts);
    const all = [...pins, ...plan.pins];
    let allow = allowSample;
    if (plan.set && !allow) {
      const [first, ...more] = sampleIn(drafts.spots, all);
      if (first) {
        if (!(await ask(orgId, [first, ...more], more.length > 0))) return false;
        allow = true;
      }
    }
    if (plan.set && !(await setDefault(plan.set.id, refused))) return false;
    return send(all, { made: plan.made, ifDefault: plan.ifDefault }, allow);
  }

  /**
   * Publishes `pins`; `refused` titles a refusal, as `told` does a publish held back. `byDefault` is
   * what `defaultPlan` gave: the default set on the way, which a refusal or a held publish says, as it
   * stays set, and the default its pins are published only while it is (`ifDefault`). Refused for
   * sample text (#360), it asks, and with Publish anyway sends it again with `allowSample`. Whether
   * it was published.
   */
  async function publish(
    orgId: string,
    pins: Pin[],
    undo = true,
    refused = 'Not published',
    byDefault: { made?: string; ifDefault?: string } = {},
    allowSample = false,
  ): Promise<boolean> {
    const { made, ifDefault } = byDefault;
    pending(true);
    try {
      // Once each: a chosen default may be the entry's own playlist.
      const drafts = [...new Map(pins.map((p) => [`${p.kind}:${p.id}`, p])).values()];
      await told(orgId, await callTool('publish', { drafts, ...(ifDefault ? { ifDefault } : {}), ...(allowSample && { allowSample }) }), undo, refused, made);
      await refresh(orgId);
      return true;
    } catch (err) {
      const [first, ...more] = sampleTextOf(err) ?? [];
      if (first && !allowSample) {
        pending(false);
        return (await ask(orgId, [first, ...more], pins.filter((p) => p.kind === 'spot').length > 1)) && publish(orgId, pins, undo, refused, byDefault, true);
      }
      const details = err instanceof Refusal && err.code === 'conflict' && typeof err.details === 'object' && err.details !== null ? err.details : undefined;
      // A conflict naming one of its pins: that draft changed since it was read.
      const pinned = details !== undefined && 'id' in details && pins.some((p) => p.id === details.id);
      // `ifDefault` refused: the default the pins were for is no longer it, the one this set included.
      if (details && 'defaultPlaylistId' in details) toast.error(refused, { description: 'Someone changed the default playlist. Reload to see it.' });
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
    publishing: { pending: false, sampleCheck: null },

    publishAnyway: () => void answer(true),

    dropSampleCheck: () => void answer(false),

    async editFirst() {
      const check = answer(false);
      if (check) await router.navigate({ to: '/spots/$spotId', params: { spotId: check.spotId } });
    },

    askSampleText: (orgId, spots) => ask(orgId, spots, spots.length > 1),

    async checkSampleText(orgId, playlistId) {
      const drafts = await readDrafts(orgId, 'Not started');
      const playlist = drafts?.playlists.find((p) => p.id === playlistId);
      if (!drafts || !playlist) return 'none';
      const [first, ...more] = sampleIn(
        drafts.spots,
        playlist.spotIds.map((id): Pin => ({ kind: 'spot', id, version: 0 })),
      );
      if (!first) return 'none';
      return (await ask(orgId, [first, ...more], more.length > 0)) ? 'allowed' : 'cancelled';
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

    async publishSchedule(orgId, entryIds, withDefault, allowSample = false) {
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
      const lists = playlists.filter((p) => needed.has(p.id));
      const inThem = new Set(lists.flatMap((p) => p.spotIds));
      const pins = [
        ...chosen.map((e): Pin => ({ kind: 'schedule_entry', id: e.id, version: e.version })),
        ...lists.filter((p) => p.draftChanged).map((p): Pin => ({ kind: 'playlist', id: p.id, version: p.version })),
        ...spots.filter((s) => inThem.has(s.id) && s.draftChanged).map((s): Pin => ({ kind: 'spot', id: s.id, version: s.version })),
      ];
      return withDefaultSet(orgId, drafts, withDefault, pins, 'Not published', allowSample, (all, byDefault, allow) =>
        publish(orgId, all, !chosen.some((e) => e.takeover), 'Not published', byDefault, allow),
      );
    },

    async publishEntry(orgId, entryId, withDefault) {
      // Called once the entry is saved: every way this ends without a publish says the draft is kept.
      const refused = 'Saved as a draft, not published';
      const drafts = await readDrafts(orgId, refused);
      if (!drafts) return false;
      const { entries, playlists, spots } = drafts;
      const entry = entries.find((e) => e.id === entryId);
      if (!entry) {
        // Gone, so not saved as a draft either.
        toast.error('Not published', { description: 'The entry is no longer there: someone may have removed it.' });
        return false;
      }
      // After the entry is found: a default is set only for a publish that will run.
      const playlist = playlists.find((p) => p.id === entry.playlistId);
      const first = playlist && !playlist.published ? playlist : null;
      const inIt = new Set(first?.spotIds ?? []);
      const pins = [
        { kind: 'schedule_entry', id: entry.id, version: entry.version } satisfies Pin,
        ...(first ? [{ kind: 'playlist', id: first.id, version: first.version } satisfies Pin] : []),
        ...spots.filter((s) => inIt.has(s.id) && !s.published).map((s): Pin => ({ kind: 'spot', id: s.id, version: s.version })),
      ];
      return withDefaultSet(orgId, drafts, withDefault, pins, refused, false, (all, byDefault, allow) => publish(orgId, all, true, refused, byDefault, allow));
    },

    async endTakeover(orgId, entryId) {
      pending(true);
      try {
        await told(orgId, await callTool('end_takeover', { scheduleEntryId: entryId }), false);
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
