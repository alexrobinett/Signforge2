/**
 * The preview channel as the CMS speaks it (M3-36, contract `PREVIEW_PROTOCOL`): the player build
 * the CMS serves for previews, and what that player says back. The spot editor's stage and the
 * brand kit's previews both use it.
 */
import { PREVIEW_PROTOCOL } from '@signforge/contract';

/** The player build at /player/ (apps/cms README), taking drafts posted from this origin. */
export const PLAYER_URL = '/player/index.html?source=preview';

/** What the player says over the preview channel (contract `PreviewPlayerMessage`), read field by field. */
export function playerMessage(data: unknown): { type: 'listening' } | { type: 'playing' } | { type: 'error'; message: string } | undefined {
  if (typeof data !== 'object' || data === null || !('sfPreview' in data) || data.sfPreview !== PREVIEW_PROTOCOL || !('type' in data)) return undefined;
  if (data.type === 'listening' || data.type === 'playing') return { type: data.type };
  if (data.type === 'error')
    return { type: 'error', message: 'message' in data && typeof data.message === 'string' ? data.message : 'The player could not show it.' };
  return undefined;
}
