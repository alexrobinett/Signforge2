/** The API's `ScreenNotifier`: the tool dispatcher tells a screen's Durable Object about a committed change. */
import type { DeviceCommand } from '@signforge/contract';
import type { ScreenNotifier } from '@signforge/tools';

export const screenObject = (env: Pick<Env, 'SCREENS'>, screenId: string) => env.SCREENS.get(env.SCREENS.idFromName(screenId));

export function screenNotifier(env: Pick<Env, 'SCREENS'>): ScreenNotifier {
  return {
    manifest: (screenId, manifestId) => screenObject(env, screenId).manifest(manifestId),
    revoked: (screenId, credentialId) => screenObject(env, screenId).revoked(credentialId),
  };
}

/** Send a command to a screen's socket. Unused until the CMS sends display overrides (M3-11). */
export const sendCommand = (env: Pick<Env, 'SCREENS'>, screenId: string, command: DeviceCommand) => screenObject(env, screenId).command(command);
