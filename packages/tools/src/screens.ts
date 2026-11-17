/** Screen tools: read screens, rename them, change their settings, revoke a credential. */
import type { DisplayHours } from '@signforge/contract';
import type { OrgScope, Screen, ScreenCredential } from '@signforge/db';
import { z } from 'zod';
import { displayHours, id, locale, name, orientation, timezone } from './fields';
import { nextOutput, page, pageInput } from './paging';
import { defineTool, notFound } from './tool';

/** A screen as tools return it. Times are milliseconds since the epoch. */
export const screenOutput = z.object({
  id: z.string(),
  name: z.string(),
  timezone: z.string(),
  locale: z.string().nullable(),
  orientation,
  displayHours: displayHours.nullable().describe('Null means always on'),
  status: z.enum(['active', 'revoked']),
  desiredManifestId: z.string().nullable().describe('The manifest the screen should play'),
  previousManifestId: z.string().nullable().describe('The one before it, kept while the screen switches'),
  reportedManifestId: z.string().nullable().describe('The manifest the screen last said it is playing'),
  lastSeenAt: z.number().nullable(),
  playerVersion: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ScreenView = z.infer<typeof screenOutput>;

/** A credential, without its hash. */
export const credentialOutput = z.object({ id: z.string(), createdAt: z.number(), lastUsedAt: z.number().nullable(), revokedAt: z.number().nullable() });
export type CredentialView = z.infer<typeof credentialOutput>;

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
  description:
    'List the screens in the organization with their settings, status and manifests, ordered by id, a page at a time. Returns { screens: Screen[], next }; pass next as cursor for the following page.',
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ ...pageInput }),
  output: z.object({ screens: z.array(screenOutput), next: nextOutput }),
  example: {},
  handler: async ({ org, input }) => {
    const { rows, next } = page(await org.screens.list(), (s) => [s.id], input);
    return { screens: rows.map(screenView), next };
  },
});

export const getScreen = defineTool({
  name: 'get_screen',
  description:
    'Get one screen by id: its settings, status, manifests, the ids of the groups it is in, and its credentials (never their secrets). Returns { screen, groupIds, credentials }.',
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ screenId: id('screen') }),
  output: z.object({ screen: screenOutput, groupIds: z.array(z.string()), credentials: z.array(credentialOutput) }),
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
  output: z.object({ screen: screenOutput }),
  example: { screenId: 'scr_example', name: 'Lobby' },
  target: (input) => ({ kind: 'screen', id: input.screenId }),
  handler: async ({ org, input, write }) => {
    const screen = await requireScreen(org, input.screenId);
    return { screen: screenView(write(org.screens.stage.update(screen, { name: input.name }))) };
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
    .refine(
      (v) => v.timezone !== undefined || v.locale !== undefined || v.orientation !== undefined || v.displayHours !== undefined,
      'give at least one setting to change',
    ),
  output: z.object({ screen: screenOutput }),
  example: { screenId: 'scr_example', timezone: 'Europe/London', displayHours: { weekly: [{ days: [1, 2, 3, 4, 5], from: '07:00', to: '22:00' }] } },
  target: (input) => ({ kind: 'screen', id: input.screenId }),
  handler: async ({ org, input, write }) => {
    const screen = await requireScreen(org, input.screenId);
    const row = write(
      org.screens.stage.update(screen, {
        timezone: input.timezone,
        locale: input.locale,
        orientation: input.orientation,
        displayHoursJson: input.displayHours === undefined ? undefined : input.displayHours === null ? null : JSON.stringify(input.displayHours),
      }),
    );
    return { screen: screenView(row) };
  },
});

export const revokeScreenCredential = defineTool({
  name: 'revoke_screen_credential',
  description:
    "Revoke one of a screen's credentials, so a device holding it can no longer fetch anything; its open socket is closed. Use get_screen to see the credentials. Revoking an already revoked credential changes nothing. Owners only. Returns { credential }.",
  scope: 'screens:manage',
  minRole: 'owner',
  mutates: true,
  input: z.object({ screenId: id('screen'), credentialId: id('credential') }),
  output: z.object({ credential: credentialOutput }),
  example: { screenId: 'scr_example', credentialId: 'crd_example' },
  target: (input) => ({ kind: 'credential', id: input.credentialId }),
  handler: async ({ org, input, write, notify }) => {
    const cred = await org.screens.credentials.get(input.credentialId);
    if (!cred || cred.screenId !== input.screenId) throw notFound('credential', input.credentialId);
    if (cred.revokedAt != null) return { credential: credentialView(cred) };
    const row = write(org.screens.credentials.stage.update(cred, { revokedAt: Date.now() }));
    // A socket the device opened with it closes now, not when it next reconnects.
    notify((screens) => screens.revoked(cred.screenId, cred.id));
    return { credential: credentialView(row) };
  },
});

export const screenTools = [listScreens, getScreen, renameScreen, updateScreenSettings, revokeScreenCredential];
