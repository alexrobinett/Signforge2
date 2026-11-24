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
import { type SpotView, versionsById } from '~/lib/spots';
import { callTool, isConflict, isStale, toolMessage } from '~/lib/tools';
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
}

export interface PublishingSlice {
  publishing: PublishingState;
  /** Saves the open spot's draft and publishes it. */
  publishSpot: (orgId: string, spotId: string) => Promise<void>;
  /** Saves the open playlist's draft and publishes it with its changed spots. */
  publishPlaylist: (orgId: string, playlistId: string) => Promise<void>;
  /** Points screens back at what `revision` gave them (`roll_back_publish`); an Undo names the publish it undoes, refused if a later one was made. */
  rollBackTo: (orgId: string, publish: { id: string; revision: number }, undoing?: string) => Promise<void>;
  /** Makes the playlist the one every screen plays when no schedule says otherwise. */
  makeDefaultPlaylist: (orgId: string, playlistId: string) => Promise<void>;
  /**
   * Publishes schedule entries (`entryIds`, else every one with a changed draft, removals too) with
   * their changed playlists and those playlists' changed spots.
   */
  /** `firstDefault`: with no default playlist yet, the one the person chose to make the default first (#243). */
  publishSchedule: (orgId: string, entryIds?: string[], firstDefault?: string) => Promise<void>;
  /**
   * Publishes one schedule entry alone, pinned (#181): nobody else's drafts go with it. Its playlist
   * and that playlist's spots go too only when they have never been published, as the entry cannot
   * play without them; a published playlist's unpublished edits stay drafts.
   */
  publishEntry: (orgId: string, entryId: string, firstDefault?: string) => Promise<void>;
  /** Ends a takeover now: deleted and published alone, in one call (`end_takeover`). */
  endTakeover: (orgId: string, entryId: string) => Promise<void>;
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
   * `undo` is false. `refused` titles a publish that was held back, as it does a refused one.
   */
  async function told(orgId: string, r: ToolOutput<'publish'>, undo = true, refused = 'Not published') {
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
      if (held) toast.error(refused, { description: held.text, action: held.action, duration: 10_000 });
      else if (noDefault || allFailed) toast.error('No screen can play it yet', { description: reachesNone });
      else toast('Nothing to publish', { description: 'Every screen already plays this.' });
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
   * Before a publish from the Schedule's dialogs with no default playlist yet (owner, #243): the one the
   * person chose made the default first (`set_default_playlist`), and its pins, so the publish
   * publishes it and its spots if they never were. [] when there is nothing to do (one chosen
   * already, or none chosen); null when it was refused, which is said under `refused`.
   */
  async function madeDefault(choice: string | undefined, drafts: { playlists: PlaylistView[]; spots: SpotView[] }, refused: string): Promise<Pin[] | null> {
    const chosen = choice ? drafts.playlists.find((p) => p.id === choice) : undefined;
    if (!chosen || drafts.playlists.some((p) => p.isDefault)) return [];
    try {
      await callTool('set_default_playlist', { playlistId: chosen.id });
    } catch (err) {
      toast.error(refused, { description: toolMessage(err) });
      return null;
    }
    if (chosen.published) return [];
    const inIt = new Set(chosen.spotIds);
    return [
      { kind: 'playlist', id: chosen.id, version: chosen.version },
      ...drafts.spots.filter((s) => inIt.has(s.id) && !s.published).map((s): Pin => ({ kind: 'spot', id: s.id, version: s.version })),
    ];
  }

  /** Publishes `pins`; `refused` titles a refusal, as `told` does a publish held back. */
  async function publish(orgId: string, pins: Pin[], undo = true, refused = 'Not published') {
    pending(true);
    try {
      // Once each: a chosen default may be the entry's own playlist.
      const drafts = [...new Map(pins.map((p) => [`${p.kind}:${p.id}`, p])).values()];
      await told(orgId, await callTool('publish', { drafts }), undo, refused);
      await refresh(orgId);
    } catch (err) {
      toast.error(refused, {
        description: isStale(err) ? 'It changed since you opened it, perhaps in another tab. Reload and publish again.' : toolMessage(err),
      });
    } finally {
      pending(false);
    }
  }

  return {
    publishing: { pending: false },

    async publishSpot(orgId, spotId) {
      await get().saveSpotDraft(spotId);
      const d = get().spotEditor.drafts[spotId];
      const spot = queryClient.getQueryData(spotQuery(orgId, spotId).queryKey);
      if (!spot || (d?.orgId === orgId && d.status !== 'saved')) {
        toast.error('Not published', { description: 'Save the draft first: fix what is marked, then publish.' });
        return;
      }
      await publish(orgId, [{ kind: 'spot', id: spot.id, version: spot.version }]);
    },

    async publishPlaylist(orgId, playlistId) {
      await get().savePlaylistDraft(playlistId);
      const d = get().playlistEditor.drafts[playlistId];
      const playlist = queryClient.getQueryData(playlistQuery(orgId, playlistId).queryKey);
      if (!playlist || (d?.orgId === orgId && d.status !== 'saved')) {
        toast.error('Not published', { description: 'Save the draft first: fix what is marked, then publish.' });
        return;
      }
      // Read now, not from the cache: a spot edited in another tab is pinned at its version now.
      const spots = (await queryClient.query({ ...spotsQuery(orgId), staleTime: 0 })).spots;
      const inIt = new Set(playlist.spotIds);
      const changed = spots.filter((s) => inIt.has(s.id) && s.draftChanged).map((s): Pin => ({ kind: 'spot', id: s.id, version: s.version }));
      await publish(orgId, [{ kind: 'playlist', id: playlist.id, version: playlist.version }, ...changed]);
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

    async publishSchedule(orgId, entryIds, firstDefault) {
      const drafts = await readDrafts(orgId, 'Not published');
      if (!drafts) return;
      const { entries, playlists, spots } = drafts;
      const defaultPins = await madeDefault(firstDefault, drafts, 'Not published');
      if (!defaultPins) return;
      const chosen = entries.filter((e) => (entryIds ? entryIds.includes(e.id) : e.draftChanged));
      const needed = new Set(chosen.filter((e) => !e.deleted).map((e) => e.playlistId));
      const lists = playlists.filter((p) => needed.has(p.id));
      const inThem = new Set(lists.flatMap((p) => p.spotIds));
      await publish(
        orgId,
        [
          ...chosen.map((e): Pin => ({ kind: 'schedule_entry', id: e.id, version: e.version })),
          ...lists.filter((p) => p.draftChanged).map((p): Pin => ({ kind: 'playlist', id: p.id, version: p.version })),
          ...spots.filter((s) => inThem.has(s.id) && s.draftChanged).map((s): Pin => ({ kind: 'spot', id: s.id, version: s.version })),
          ...defaultPins,
        ],
        !chosen.some((e) => e.takeover),
      );
    },

    async publishEntry(orgId, entryId, firstDefault) {
      // Called once the entry is saved: every way this ends without a publish says the draft is kept.
      const refused = 'Saved as a draft, not published';
      const drafts = await readDrafts(orgId, refused);
      if (!drafts) return;
      const { entries, playlists, spots } = drafts;
      const defaultPins = await madeDefault(firstDefault, drafts, refused);
      if (!defaultPins) return;
      const entry = entries.find((e) => e.id === entryId);
      if (!entry) {
        toast.error(refused, { description: 'The entry is no longer there: someone may have removed it.' });
        return;
      }
      const playlist = playlists.find((p) => p.id === entry.playlistId);
      const first = playlist && !playlist.published ? playlist : null;
      const inIt = new Set(first?.spotIds ?? []);
      await publish(
        orgId,
        [
          { kind: 'schedule_entry', id: entry.id, version: entry.version },
          ...(first ? [{ kind: 'playlist', id: first.id, version: first.version } satisfies Pin] : []),
          ...spots.filter((s) => inIt.has(s.id) && !s.published).map((s): Pin => ({ kind: 'spot', id: s.id, version: s.version })),
          ...defaultPins,
        ],
        true,
        refused,
      );
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
