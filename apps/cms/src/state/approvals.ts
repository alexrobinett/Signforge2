/**
 * The approvals queue (#115, canvas board AgentApprovals): approve or decline a publish request, each
 * through its own tool as the person; and the stage split, each pinned spot on the real player twice,
 * as screens have it now and as approving publishes it.
 *
 * Approve asks first, showing exactly what the request pinned: its drafts at their versions, and the
 * spots still holding their template's sample text, which approving acknowledges exactly as
 * `check_publish_request` named them (#392's `allowSample`). Its toast's Undo is a roll back to the
 * publish before (M3-18); a decline's puts the request back (`reopen_publish_request`).
 */
import { PREVIEW_PROTOCOL } from '@signforge/contract';
import { toast } from 'sonner';
import type { ApprovalItem } from '~/lib/approvals';
import { playerMessage } from '~/lib/preview';
import { versionName } from '~/lib/publishes';
import { compilePreview, draftOf, type SpotView, versionsById } from '~/lib/spots';
import { callTool, toolMessage } from '~/lib/tools';
import { assetsQuery, spotPreviewQuery, templatesQuery } from '~/queries/spots';
import type { SliceCreator } from './store';

/** One stage's player: the frame, and the spot it plays, as screens have it or as approving publishes it. */
interface ApprovalStageTarget {
  frame: Window;
  orgId: string;
  spot: SpotView;
}

interface ApprovalsState {
  /**
   * The request whose Approve was pressed, as its confirmation shows it: frozen when pressed, so a read of
   * the queue meanwhile cannot change what the button approves (review of #409).
   */
  confirming: ApprovalItem | null;
  /** The request a decision (or its Undo) is on its way for. */
  deciding: string | null;
  /** Each stage's player, by its key: playing, or why not. */
  stages: Record<string, { playing: boolean; error: string | null }>;
  /** The width the stages have, for scaling the players to fit. */
  stageWidth: number | null;
}

export interface ApprovalsSlice {
  approvals: ApprovalsState;
  askApprove: (item: ApprovalItem) => void;
  cancelApprove: () => void;
  /**
   * Approves what the confirmation showed: the request's pins, with its sample text acknowledged exactly as
   * checked, held to the screens it switches and the default as checked (`ifScreens`, `ifDefault`).
   */
  approveRequest: (orgId: string, item: ApprovalItem) => Promise<void>;
  declineRequest: (orgId: string, requestId: string) => Promise<void>;
  /** A decline's Undo: the request waits again. */
  reopenRequest: (orgId: string, requestId: string) => Promise<void>;
  attachApprovalStage: (key: string, target: ApprovalStageTarget | null) => void;
  measureApprovalStage: (width: number) => void;
}

const initial: ApprovalsState = { confirming: null, deciding: null, stages: {}, stageWidth: null };

const screensWord = (n: number) => (n === 1 ? '1 screen' : `${n} screens`);

export const createApprovalsSlice: SliceCreator<ApprovalsSlice> = (set, get, { queryClient, router }) => {
  const approvals = (change: (a: ApprovalsState) => ApprovalsState) => set((s) => ({ approvals: change(s.approvals) }));
  const stage = (key: string, status: { playing: boolean; error: string | null }) => approvals((a) => ({ ...a, stages: { ...a.stages, [key]: status } }));
  /** Everything a decision can change: the queue, drafts' published state, screens, the rollout and the sidebar's counts. */
  const refresh = (orgId: string) => queryClient.invalidateQueries({ queryKey: ['org', orgId] });
  const links = new Map<string, ApprovalStageTarget>();
  let hearing = false;

  /** The spot compiled for its player, and posted; or why it cannot be, said under it. */
  async function play(key: string, t: ApprovalStageTarget) {
    try {
      const [templates, assets, preview] = await Promise.all([
        queryClient.query(templatesQuery(t.orgId)),
        queryClient.query(assetsQuery(t.orgId)),
        queryClient.query(spotPreviewQuery(t.orgId, { orientation: 'landscape', templateVersionId: t.spot.templateVersionId ?? undefined })),
      ]);
      const result = await compilePreview({
        spot: t.spot,
        draft: draftOf(t.spot),
        versions: versionsById(templates.templates),
        preview: preview.preview,
        timezone: preview.timezone,
        assets: assets.assets,
        orientation: 'landscape',
        // Bound fields play their fallback values: the page posts no data.
        live: false,
      });
      if (links.get(key) !== t) return;
      if (!result.manifest) {
        stage(key, { playing: false, error: result.problems.join('; ') || 'It cannot be played.' });
        return;
      }
      t.frame.postMessage({ sfPreview: PREVIEW_PROTOCOL, type: 'draft', manifest: result.manifest, data: [] }, location.origin);
    } catch (err) {
      if (links.get(key) === t) stage(key, { playing: false, error: `what it needs did not load (${toolMessage(err)})` });
    }
  }

  /** What the stages' players say. Only attached frames, on this origin, are listened to. */
  const hear = (e: MessageEvent) => {
    if (e.origin !== location.origin) return;
    const found = [...links].find(([, t]) => t.frame === e.source);
    const msg = found && playerMessage(e.data);
    if (!found || !msg) return;
    const [key, t] = found;
    if (msg.type === 'listening') void play(key, t);
    else stage(key, msg.type === 'playing' ? { playing: true, error: null } : { playing: false, error: msg.message });
  };

  return {
    approvals: initial,

    askApprove: (confirming) => approvals((a) => ({ ...a, confirming })),
    cancelApprove: () => approvals((a) => ({ ...a, confirming: null })),

    async approveRequest(orgId, { check }) {
      const { request, samples } = check;
      if (get().approvals.deciding) return;
      approvals((a) => ({ ...a, confirming: null, deciding: request.id }));
      try {
        const out = await callTool('approve_publish_request', {
          publishRequestId: request.id,
          // What the person was shown: refused if the screens it switches or the default changed since.
          ifScreens: check.screens.map((x) => x.id),
          ifDefault: check.defaultPlaylistId,
          // Exactly the sample text the confirmation listed, or none: any other is refused (#392).
          ...(samples.length ? { allowSample: samples.map((x) => ({ spotId: x.spotId, version: x.version, fields: x.fields })) } : {}),
        });
        const made = out.published.publish;
        const previous = made?.previousId;
        toast.success(made?.screens ? 'Approved. Rollout started.' : 'Approved', {
          description: made
            ? `Published ${versionName(made)} as you${made.screens ? ` to ${screensWord(made.screens)}; each switches as it hears of it` : ''}.`
            : 'Every screen already plays what it asked for.',
          // M3-18's roll back to the publish before, as an editor's publish toast offers it.
          action:
            made && previous && made.screens
              ? { label: 'Undo', onClick: () => void get().rollBackTo(orgId, { id: previous, revision: made.revision - 1 }, made.id) }
              : undefined,
          cancel: made ? { label: 'View rollout', onClick: () => void router.navigate({ to: '/publishes', search: { id: made.id } }) } : undefined,
          duration: 10_000,
        });
      } catch (err) {
        toast.error('Not approved', { description: toolMessage(err) });
      } finally {
        approvals((a) => ({ ...a, deciding: null }));
        await refresh(orgId);
      }
    },

    async declineRequest(orgId, requestId) {
      if (get().approvals.deciding) return;
      approvals((a) => ({ ...a, deciding: requestId }));
      try {
        const { request } = await callTool('decline_publish_request', { publishRequestId: requestId });
        toast(`Declined. The ${request.requestedBy.kind === 'agent' ? 'agent' : 'member'} is told.`, {
          description: 'Nothing was published; the draft stays as it is.',
          action: { label: 'Undo', onClick: () => void get().reopenRequest(orgId, requestId) },
          duration: 10_000,
        });
      } catch (err) {
        toast.error('Not declined', { description: toolMessage(err) });
      } finally {
        approvals((a) => ({ ...a, deciding: null }));
        await refresh(orgId);
      }
    },

    async reopenRequest(orgId, requestId) {
      if (get().approvals.deciding) return;
      approvals((a) => ({ ...a, deciding: requestId }));
      try {
        await callTool('reopen_publish_request', { publishRequestId: requestId });
        toast('Put back. It is waiting for approval again.');
      } catch (err) {
        toast.error('Not put back', { description: toolMessage(err) });
      } finally {
        approvals((a) => ({ ...a, deciding: null }));
        await refresh(orgId);
      }
    },

    attachApprovalStage(key, target) {
      // Called from a ref callback, so only in the browser; the listener is added once.
      if (target && !hearing) {
        window.addEventListener('message', hear);
        hearing = true;
      }
      if (!target) {
        links.delete(key);
        return;
      }
      if (links.get(key)?.frame === target.frame && links.get(key)?.spot === target.spot) return;
      links.set(key, target);
      stage(key, { playing: false, error: null });
      // A player already listening (its frame kept, a new read of the spot) is posted at once; a new one says when it listens.
      void play(key, target);
    },

    measureApprovalStage: (stageWidth) => approvals((a) => (a.stageWidth === stageWidth ? a : { ...a, stageWidth })),
  };
};
