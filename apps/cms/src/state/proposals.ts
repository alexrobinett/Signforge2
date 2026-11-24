/**
 * An agent's proposal in the spot and playlist editors (M4-11, #116, canvas board IdeaAgentDraft):
 * Reject puts back the draft the agent wrote over, the person's or the published one, and keeps the
 * agent's beside it, which the toast's Undo puts back (`revert_spot_draft`, `revert_playlist_draft`);
 * Keep makes the agent's draft the draft (`keep_*_draft`). Each is held to the version shown. The
 * editor reads the draft again after either, its own unsaved edit included: the panel offers neither
 * while one is waiting to save, as that save ends the proposal itself.
 */
import { toast } from 'sonner';
import { orgOnScreen } from '~/lib/live';
import { callTool, toolMessage } from '~/lib/tools';
import { proposalKeys } from '~/queries/proposals';
import type { SliceCreator } from './store';

type Kind = 'spot' | 'playlist';

interface ProposalsState {
  /** The draft a Reject, Keep or Undo is on its way for (`kind:id`). */
  pending: string | null;
}

export interface ProposalsSlice {
  proposals: ProposalsState;
  /** Reject the agent's draft shown at `version`, or, when it was rejected, put it back (the Undo). */
  rejectProposal: (orgId: string, kind: Kind, id: string, version: number) => Promise<void>;
  keepProposal: (orgId: string, kind: Kind, id: string, version: number) => Promise<void>;
}

export const createProposalsSlice: SliceCreator<ProposalsSlice> = (set, get, { queryClient, router }) => {
  const pending = (p: string | null) => set({ proposals: { pending: p } });
  /** The editor's draft and the proposal, read again. */
  const reread = async (orgId: string, kind: Kind, id: string) => {
    await Promise.all([
      kind === 'spot' ? get().reloadSpot(orgId, id) : get().reloadPlaylist(orgId, id),
      queryClient.invalidateQueries({ queryKey: proposalKeys.all(orgId) }),
    ]);
  };
  /** Whether the tab still shows `orgId`: an answer, or an Undo pressed, after it moved to another org does nothing there. */
  const showing = (orgId: string) => orgOnScreen(router) === orgId;
  /**
   * One action at a time, said in a toast either way: pending until the editor has read the draft again, so
   * a second press cannot go from the version the first changed (review of #410).
   */
  /** The action on its way, with its read again, if any: what a toast's Undo waits for. */
  let running: Promise<void> | null = null;
  const run = async (orgId: string, kind: Kind, id: string, act: () => Promise<void>, refused: string) => {
    if (get().proposals.pending || !showing(orgId)) return;
    pending(`${kind}:${id}`);
    const going = (async () => {
      try {
        await act();
      } catch (err) {
        if (showing(orgId)) toast.error(refused, { description: toolMessage(err) });
      }
      try {
        if (showing(orgId)) await reread(orgId, kind, id);
      } finally {
        pending(null);
      }
    })();
    running = going;
    try {
      await going;
    } finally {
      if (running === going) running = null;
    }
  };
  /** A toast's Undo: at once, or, pressed while the Reject is still being read again, once it is (review of #410). */
  const once = (go: () => void) => (running ? void running.then(go) : go());

  return {
    proposals: { pending: null },

    rejectProposal: (orgId, kind, id, version) =>
      run(
        orgId,
        kind,
        id,
        async () => {
          // Sent for `orgId`: a tab whose org changed meanwhile is refused (ORG_CHANGED), never acting on the other.
          const out =
            kind === 'spot'
              ? await callTool('revert_spot_draft', { spotId: id, ifVersion: version }, orgId)
              : await callTool('revert_playlist_draft', { playlistId: id, ifVersion: version }, orgId);
          const now = 'spot' in out ? out.spot.version : out.playlist.version;
          if (!showing(orgId)) return;
          if (!out.rejected) {
            toast("The agent's draft is back");
            return;
          }
          toast("Rejected the agent's draft", {
            description: 'The draft it wrote over is back. Nothing on screens changed.',
            action: { label: 'Undo', onClick: () => once(() => void get().rejectProposal(orgId, kind, id, now)) },
            duration: 10_000,
          });
        },
        'Not rejected',
      ),

    keepProposal: (orgId, kind, id, version) =>
      run(
        orgId,
        kind,
        id,
        async () => {
          if (kind === 'spot') await callTool('keep_spot_draft', { spotId: id, ifVersion: version }, orgId);
          else await callTool('keep_playlist_draft', { playlistId: id, ifVersion: version }, orgId);
          if (!showing(orgId)) return;
          toast("Kept the agent's draft", { description: 'It is the draft now. Publish it when you are ready.' });
        },
        'Not kept',
      ),
  };
};
