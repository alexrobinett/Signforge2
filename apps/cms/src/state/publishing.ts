/**
 * Publishing from the editors (canvas boards Spot editor A and Ideas 5-6): publish what is open,
 * undo it, roll back to an earlier publish, and choose the default playlist.
 *
 * A publish from an editor saves the draft first, then publishes it pinned at the version saved
 * (`publish` with `drafts`), so it publishes exactly what the person sees and nobody else's
 * unfinished drafts. A playlist publishes with its spots that have unpublished changes, since its
 * stage plays their saved drafts. The toast says what reached screens, with Undo (a roll back to
 * the publish before) and a link to the rollout. Confirmation dialogs are kept for revoking and
 * deleting: a publish is undone instead (docs/research/cms-ux.md).
 */
import { toast } from 'sonner';
import { publishResultOf, madeOf, versionName, type PublishResult } from '~/lib/publishes';
import { callTool, isStale, playlistOf, toolMessage } from '~/lib/tools';
import { playlistKeys, playlistQuery } from '~/queries/playlists';
import { spotQuery, spotsQuery } from '~/queries/spots';
import type { SliceCreator } from './store';

interface Pin {
  kind: 'spot' | 'playlist';
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
  /** Points screens back at what `revision` gave them (`roll_back_publish`). */
  rollBackTo: (orgId: string, publish: { id: string; revision: number }) => Promise<void>;
  /** Makes the playlist the one every screen plays when no schedule says otherwise. */
  makeDefaultPlaylist: (orgId: string, playlistId: string) => Promise<void>;
}

const screensWord = (n: number) => (n === 1 ? '1 screen' : `${n} screens`);

export const createPublishingSlice: SliceCreator<PublishingSlice> = (set, get, { queryClient, router }) => {
  const pending = (on: boolean) => set((s) => ({ publishing: { ...s.publishing, pending: on } }));
  /** Everything a publish can change: drafts' published state, playlists, screens and the rollout. */
  const refresh = (orgId: string) => queryClient.invalidateQueries({ queryKey: ['org', orgId] });
  const viewRollout = (id: string) => ({ label: 'View rollout', onClick: () => void router.navigate({ to: '/publishes', search: { id } }) });

  /** The toast for a publish's answer: what reached screens, else why nothing did. */
  function told(orgId: string, r: PublishResult) {
    const held = r.held.flatMap((h) => h.problems)[0];
    const noDefault = r.screens.some((s) => s.problems.includes('the organization has no default playlist'));
    const reachesNone = noDefault
      ? 'No screen can play anything yet: choose a default playlist, with Play on every screen on a playlist.'
      : r.screens.length
        ? 'No screen plays it yet: add it to a playlist that screens play.'
        : 'No screen is paired yet.';
    if (!r.publish) {
      if (held) toast.error('Not published', { description: `It does not pass its checks: ${held}.` });
      else if (noDefault) toast.error('No screen can play it yet', { description: reachesNone });
      else toast('Nothing to publish', { description: 'Every screen already plays this.' });
      return;
    }
    const made = r.publish;
    const v = versionName(made);
    const failed = r.screens.filter((s) => s.outcome === 'failed').length;
    const notes = [
      made.screens ? 'Each screen switches as it hears of it; the rollout says why any wait.' : reachesNone,
      held && `Held back: ${held}.`,
      made.screens > 0 && failed > 0 && `${screensWord(failed)} could not take it and keep what they play.`,
    ].filter(Boolean);
    const previous = made.previousId;
    toast.success(made.screens ? `Published ${v} to ${screensWord(made.screens)}` : `Published ${v}`, {
      description: notes.join(' '),
      ...(previous && made.screens ? { action: { label: 'Undo', onClick: () => void get().rollBackTo(orgId, { id: previous, revision: made.revision - 1 }) } } : {}),
      cancel: viewRollout(made.id),
      duration: 10_000,
    });
  }

  async function publish(orgId: string, pins: Pin[]) {
    pending(true);
    try {
      told(orgId, publishResultOf(await callTool('publish', { drafts: pins })));
      await refresh(orgId);
    } catch (err) {
      toast.error('Not published', {
        description: isStale(err) ? 'It changed since you opened it, perhaps in another tab. Reload and publish again.' : toolMessage(err),
      });
    } finally {
      pending(false);
    }
  }

  return {
    publishing: { pending: false },

    async publishSpot(orgId, spotId) {
      await get().saveSpotDraft();
      const e = get().spotEditor;
      const spot = queryClient.getQueryData(spotQuery(orgId, spotId).queryKey);
      if (!spot || e.status !== 'saved' || e.stale) {
        toast.error('Not published', { description: 'Save the draft first: fix what is marked, then publish.' });
        return;
      }
      await publish(orgId, [{ kind: 'spot', id: spot.id, version: spot.version }]);
    },

    async publishPlaylist(orgId, playlistId) {
      await get().savePlaylistDraft();
      const e = get().playlistEditor;
      const playlist = queryClient.getQueryData(playlistQuery(orgId, playlistId).queryKey);
      if (!playlist || (e.playlistId === playlistId && (e.status !== 'saved' || e.stale || e.gone))) {
        toast.error('Not published', { description: 'Save the draft first: fix what is marked, then publish.' });
        return;
      }
      // Read now, not from the cache: a spot edited in another tab is pinned at its version now.
      const spots = (await queryClient.query({ ...spotsQuery(orgId), staleTime: 0 })).spots;
      const inIt = new Set(playlist.spotIds);
      const changed = spots.filter((s) => inIt.has(s.id) && s.draftChanged).map((s): Pin => ({ kind: 'spot', id: s.id, version: s.version }));
      await publish(orgId, [{ kind: 'playlist', id: playlist.id, version: playlist.version }, ...changed]);
    },

    async rollBackTo(orgId, target) {
      pending(true);
      try {
        const made = madeOf(await callTool('roll_back_publish', { publishId: target.id }));
        const v = versionName(target);
        if (!made) toast('Nothing to roll back', { description: `Every screen already has what ${v} gave it.` });
        else
          toast.success(`Screens pointed back at ${v}`, {
            description: `Nothing was rebuilt or deleted: the newer publishes stay in the history. The next publish sends today's published content again.`,
            cancel: viewRollout(made.id),
            duration: 10_000,
          });
        await refresh(orgId);
      } catch (err) {
        toast.error('Not rolled back', { description: toolMessage(err) });
      } finally {
        pending(false);
      }
    },

    async makeDefaultPlaylist(orgId, playlistId) {
      pending(true);
      try {
        const playlist = playlistOf(await callTool('set_default_playlist', { playlistId }));
        queryClient.setQueryData(playlistKeys.one(orgId, playlistId), playlist);
        await queryClient.invalidateQueries({ queryKey: playlistKeys.all(orgId), exact: true });
        toast.success(`${playlist.name} plays on every screen`, { description: 'From the next publish, wherever no schedule says otherwise.' });
      } catch (err) {
        toast.error('Not changed', { description: toolMessage(err) });
      } finally {
        pending(false);
      }
    },
  };
};
