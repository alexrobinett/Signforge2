/** The API's `ScreenNotifier`: the tool dispatcher tells a screen's Durable Object about a committed change. */
import type { ScreenNotifier } from '@signforge/tools';

export const screenObject = (env: Pick<Env, 'SCREENS'>, screenId: string) => env.SCREENS.get(env.SCREENS.idFromName(screenId));

export function screenNotifier(env: Pick<Env, 'SCREENS'>): ScreenNotifier {
  return {
    manifest: (screenId, manifestId) => screenObject(env, screenId).manifest(manifestId),
    revoked: (screenId, credentialId) => screenObject(env, screenId).revoked(credentialId),
  };
}
