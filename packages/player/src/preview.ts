/**
 * The preview content source (`?source=preview`, see source.ts): the CMS editor frames the real
 * player build and posts it drafts.
 *
 * This is an inbound surface, so it is gated twice. The player listens only while the CMS origin
 * is its parent (`location.ancestorOrigins`), and takes a message only when it comes from that
 * parent window and that origin. It replies to that origin only. The CMS origin is a build
 * setting, `CMS_ORIGIN` (vite.config.ts), the API's setting of the same name; unset, it is the
 * player's own origin.
 *
 * A draft becomes the manifest playing once all its files are at hand: posted with it, or fetched
 * from `<cms>/api/blobs/<sha256>` with the user's session. If the spot on screen is in the new draft
 * it is updated in place at once (Slot.update); otherwise the draft shows at the next spot.
 */
import {
  PREVIEW_PROTOCOL,
  requiredFiles,
  validatePreviewHostMessage,
  type PreviewDraftMessage,
  type PreviewPlayerMessage,
  type ScreenManifest,
} from '@signforge/contract';
import { usePostedData } from './data';
import { readFilesFrom } from './source';

declare const __SF_CMS_ORIGIN__: string;

/** The only origin whose pages may drive the preview. */
const CMS_ORIGIN = __SF_CMS_ORIGIN__ || location.origin;

/** Whether the CMS origin frames this player directly. */
function framedByCms(): boolean {
  if (window.parent === window) return false;
  // Chromium lists the ancestors' origins; elsewhere the per-message checks below still hold.
  const ancestors = location.ancestorOrigins as DOMStringList | undefined;
  return !ancestors || ancestors[0] === CMS_ORIGIN;
}

export interface PreviewHooks {
  /** Make `manifest` the one playing. Resolves with the id of the spot updated on screen, if one was. */
  adopt(manifest: ScreenManifest): Promise<string | undefined>;
  /** Show a line in the player's status overlay. */
  status(text: string): void;
}

export interface Preview {
  /** A spot of `manifest` started playing. */
  played(manifest: string, spot: string): void;
  /** A spot could not be shown. */
  failed(message: string): void;
}

/** Start listening for drafts. Returns what the playback loop reports back through. */
export function startPreview(hooks: PreviewHooks): Preview {
  if (!framedByCms()) {
    hooks.status('SignForge preview\nOpen this from the editor.');
    return { played: () => {}, failed: () => {} };
  }
  const send = (m: PreviewPlayerMessage) => window.parent.postMessage(m, CMS_ORIGIN);
  /** Files of the latest two drafts: the playback loop may still be loading a spot of the one before. */
  let files = new Map<string, Blob>();
  let previous = new Map<string, Blob>();
  readFilesFrom(async (sha) => {
    const blob = files.get(sha) ?? previous.get(sha);
    if (!blob) throw new Error(`file ${sha.slice(0, 12)} is not in the draft`);
    return blob;
  });

  /** Every file of the draft, from what was posted, held, or the CMS blob route. */
  async function gather(msg: PreviewDraftMessage): Promise<Map<string, Blob>> {
    const out = new Map<string, Blob>();
    await Promise.all(
      [...requiredFiles(msg.manifest)].map(async (sha) => {
        let blob = msg.files?.[sha] ?? files.get(sha) ?? previous.get(sha);
        if (!blob) {
          const res = await fetch(`${CMS_ORIGIN}/api/blobs/${sha}`, { credentials: 'include', signal: AbortSignal.timeout(20_000) });
          if (!res.ok) throw new Error(`file ${sha.slice(0, 12)}: ${res.status}`);
          blob = await res.blob();
        }
        out.set(sha, blob);
      }),
    );
    return out;
  }

  let latest = 0;
  addEventListener('message', (e: MessageEvent<unknown>) => {
    if (e.source !== window.parent || e.origin !== CMS_ORIGIN) return;
    const problems = validatePreviewHostMessage(e.data);
    if (problems.length) return send({ sfPreview: PREVIEW_PROTOCOL, type: 'error', message: `draft refused: ${problems[0]}` });
    const msg = e.data as PreviewDraftMessage;
    const n = ++latest;
    void gather(msg)
      .then(async (got) => {
        // A newer draft arrived while this one gathered its files: it wins.
        if (n !== latest) return;
        previous = files;
        files = got;
        usePostedData(msg.manifest, msg.data ?? []);
        hooks.status('');
        const updated = await hooks.adopt(msg.manifest);
        if (updated && n === latest) send({ sfPreview: PREVIEW_PROTOCOL, type: 'playing', manifest: msg.manifest.id, spot: updated });
      })
      .catch((err: unknown) => {
        if (n === latest) send({ sfPreview: PREVIEW_PROTOCOL, type: 'error', message: err instanceof Error ? err.message : String(err) });
      });
  });
  hooks.status('SignForge preview\nWaiting for the draft…');
  send({ sfPreview: PREVIEW_PROTOCOL, type: 'listening' });
  return {
    played: (manifest, spot) => send({ sfPreview: PREVIEW_PROTOCOL, type: 'playing', manifest, spot }),
    failed: (message) => send({ sfPreview: PREVIEW_PROTOCOL, type: 'error', message }),
  };
}
