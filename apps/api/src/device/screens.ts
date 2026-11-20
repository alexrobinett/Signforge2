/** The API's `ScreenNotifier`: the tool dispatcher tells a screen's Durable Object about a committed change; a publish's screens go through a queue (../publish.ts). */
import type { ScreenNotifier } from '@signforge/tools';

/** Screens per queue message, as measured in the M3-00 spike (spike/m3-platform/RESULTS.md, 9). */
const SCREENS_PER_MESSAGE = 50;

/** A queue message: screens a publish switched, and the manifest each should now play. */
export interface PublishNotice {
  screens: { screenId: string; manifestId: string }[];
}

/** Queue telling these screens of their new manifests, 50 screens a message. */
export async function queueNotices(env: Pick<Env, 'PUBLISH_NOTICES'>, screens: readonly { screenId: string; manifestId: string }[]): Promise<void> {
  const messages: MessageSendRequest<PublishNotice>[] = [];
  for (let i = 0; i < screens.length; i += SCREENS_PER_MESSAGE) messages.push({ body: { screens: screens.slice(i, i + SCREENS_PER_MESSAGE) } });
  // A send takes at most 100 messages: 5,000 screens.
  for (let i = 0; i < messages.length; i += 100) await env.PUBLISH_NOTICES.sendBatch(messages.slice(i, i + 100));
}

export const screenObject = (env: Pick<Env, 'SCREENS'>, screenId: string) => env.SCREENS.get(env.SCREENS.idFromName(screenId));

export function screenNotifier(env: Pick<Env, 'SCREENS' | 'PUBLISH_NOTICES'>): ScreenNotifier {
  return {
    manifest: (screenId, manifestId) => screenObject(env, screenId).manifest(manifestId),
    manifests: (changes) => queueNotices(env, changes),
    revoked: (screenId, credentialId) => screenObject(env, screenId).revoked(credentialId),
    command: (screenId, command) => screenObject(env, screenId).command(command),
  };
}
