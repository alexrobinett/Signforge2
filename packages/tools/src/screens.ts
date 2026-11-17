/** Screen tools: read screens, rename them, change their settings, revoke a credential. */
import type { DisplayHours } from '@signforge/contract';
import type { OrgScope, Screen, ScreenCredential } from '@signforge/db';
import { z } from 'zod';
import { displayHours, id, locale, name, orientation, timezone } from './fields';
import { defineTool, notFound } from './tool';

/** A screen as tools return it. Times are milliseconds since the epoch. */
export interface ScreenView {
  id: string;
  name: string;
  timezone: string;
  locale: string | null;
  orientation: 'landscape' | 'portrait';
  /** Null means always on. */
  displayHours: DisplayHours | null;
  status: 'active' | 'revoked';
  /** The manifest the screen should play, and the one before it. */
  desiredManifestId: string | null;
  previousManifestId: string | null;
  /** The manifest the screen last said it is playing. */
  reportedManifestId: string | null;
  lastSeenAt: number | null;
  playerVersion: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A credential, without its hash. */
export interface CredentialView {
  id: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export const screenView = (s: Screen): ScreenView => ({
  id: s.id,
  name: s.name,
  timezone: s.timezone,
  locale: s.locale,
  orientation: s.orientation,
  displayHours: s.displayHoursJson ? (JSON.parse(s.displayHoursJson) as DisplayHours) : null,
  status: s.status,
  desiredManifestId: s.desiredManifestId,
  previousManifestId: s.previousManifestId,
  reportedManifestId: s.reportedManifestId,
  lastSeenAt: s.lastSeenAt,
  playerVersion: s.playerVersion,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});

const credentialView = (c: ScreenCredential): CredentialView => ({ id: c.id, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt, revokedAt: c.revokedAt });

async function requireScreen(org: OrgScope, screenId: string) {
  const row = await org.screens.get(screenId);
  if (!row) throw notFound('screen', screenId);
  return row;
}

export const listScreens = defineTool({
  name: 'list_screens',
  description: 'List every screen in the organization with its settings, status and manifests, ordered by id. Returns { screens: Screen[] }.',
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({}),
  example: {},
  handler: async ({ org }) => ({ screens: (await org.screens.list()).map(screenView) }),
});

export const getScreen = defineTool({
  name: 'get_screen',
  description: 'Get one screen by id: its settings, status, manifests, the ids of the groups it is in, and its credentials (never their secrets). Returns { screen, groupIds, credentials }.',
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ screenId: id('screen') }),
  example: { screenId: 'scr_example' },
  handler: async ({ org, input }) => {
    const screen = await requireScreen(org, input.screenId);
    const [groupIds, credentials] = await Promise.all([org.screens.groupsOf(screen.id), org.screens.credentials.forScreen(screen.id)]);
    return { screen: screenView(screen), groupIds, credentials: credentials.map(credentialView) };
  },
});

export const renameScreen = defineTool({
  name: 'rename_screen',
  description: 'Rename a screen. The name is what people see in the CMS; screens do not show it. Returns { screen }.',
  scope: 'screens:manage',
  minRole: 'editor',
  mutates: true,
  input: z.object({ screenId: id('screen'), name: name('screen') }),
  example: { screenId: 'scr_example', name: 'Lobby' },
  target: (input) => ({ kind: 'screen', id: input.screenId }),
  handler: async ({ org, input }) => {
    const row = await org.screens.update(input.screenId, { name: input.name });
    if (!row) throw notFound('screen', input.screenId);
    return { screen: screenView(row) };
  },
});

export const updateScreenSettings = defineTool({
  name: 'update_screen_settings',
  description:
    "Change a screen's time zone, locale, orientation or display hours. Give only the fields to change; null clears locale (the player's default) or display hours (always on). Display hours are checked as the player checks them. The screen picks the change up with the next publish to it. Returns { screen }.",
  scope: 'screens:manage',
  minRole: 'editor',
  mutates: true,
  input: z
    .object({
      screenId: id('screen'),
      timezone: timezone.optional(),
      locale: locale.nullable().optional(),
      orientation: orientation.optional(),
      displayHours: displayHours.nullable().optional(),
    })
    .refine((v) => v.timezone !== undefined || v.locale !== undefined || v.orientation !== undefined || v.displayHours !== undefined, 'give at least one setting to change'),
  example: { screenId: 'scr_example', timezone: 'Europe/London', displayHours: { weekly: [{ days: [1, 2, 3, 4, 5], from: '07:00', to: '22:00' }] } },
  target: (input) => ({ kind: 'screen', id: input.screenId }),
  handler: async ({ org, input }) => {
    const row = await org.screens.update(input.screenId, {
      timezone: input.timezone,
      locale: input.locale,
      orientation: input.orientation,
      displayHoursJson: input.displayHours === undefined ? undefined : input.displayHours === null ? null : JSON.stringify(input.displayHours),
    });
    if (!row) throw notFound('screen', input.screenId);
    return { screen: screenView(row) };
  },
});

export const revokeScreenCredential = defineTool({
  name: 'revoke_screen_credential',
  description:
    'Revoke one of a screen\'s credentials, so a device holding it can no longer fetch anything. Use get_screen to see the credentials. Revoking an already revoked credential changes nothing. Owners only. Returns { credential }.',
  scope: 'screens:manage',
  minRole: 'owner',
  mutates: true,
  input: z.object({ screenId: id('screen'), credentialId: id('credential') }),
  example: { screenId: 'scr_example', credentialId: 'crd_example' },
  target: (input) => ({ kind: 'credential', id: input.credentialId }),
  handler: async ({ org, input }) => {
    const cred = await org.screens.credentials.get(input.credentialId);
    if (!cred || cred.screenId !== input.screenId) throw notFound('credential', input.credentialId);
    if (cred.revokedAt != null) return { credential: credentialView(cred) };
    const row = await org.screens.credentials.update(cred.id, { revokedAt: Date.now() });
    if (!row) throw notFound('credential', input.credentialId);
    return { credential: credentialView(row) };
  },
});

export const screenTools = [listScreens, getScreen, renameScreen, updateScreenSettings, revokeScreenCredential];
