/** Screen tools: read screens, rename them, change their settings, wake or sleep them, identify, restart, revoke a credential. */
import { SCREEN_KINDS, type DisplayHours, type DisplayOverride, type ScreenManifest } from '@signforge/contract';
import type { OrgScope, Screen, ScreenCredential } from '@signforge/db';
import { nextDisplayChange } from '@signforge/player-core';
import { z } from 'zod';
import { displayHours, id, ifVersion, locale, name, orientation, timezone, version } from './fields';
import { parseHeartbeat } from './heartbeat';
import { nextOutput, page, pageInput } from './paging';
import { manifestKey } from './r2';
import { NEEDS_YOU_REASONS, screenState, shouldBeShowing, STATE_KINDS } from './screen-state';
import { defineTool, notFound } from './tool';

/** How long a display override lasts at most: on a screen without display hours, and over a closed weekend. */
export const OVERRIDE_LIMIT_MS = 12 * 3_600_000;
/** How long `identify_screen` shows the screen's name. */
export const IDENTIFY_SECONDS = 10;

const displayOverrideOutput = z.object({ state: z.enum(['on', 'off']), until: z.string().describe('ISO 8601; the override ends by itself then') });

/** A screen as tools return it. Times are milliseconds since the epoch. */
export const screenOutput = z.object({
  id: z.string(),
  name: z.string(),
  timezone: z.string(),
  locale: z.string().nullable(),
  orientation,
  kind: z.enum(SCREEN_KINDS).describe('device, or browser: a test screen in a browser tab, which has no panel to power'),
  displayHours: displayHours.nullable().describe('Null means always on'),
  status: z.enum(['active', 'revoked']).describe('Revoked once every credential the screen had is revoked'),
  desiredManifestId: z.string().nullable().describe('The manifest the screen should play'),
  previousManifestId: z.string().nullable().describe('The one before it, kept while the screen switches'),
  reportedManifestId: z.string().nullable().describe('The manifest the screen last said it is playing'),
  lastSeenAt: z.number().nullable(),
  playerVersion: z.string().nullable(),
  displayOverride: displayOverrideOutput.nullable().describe('A wake now or sleep now in force, set with set_display_override'),
  state: z
    .object({
      kind: z.enum(STATE_KINDS),
      reason: z
        .enum(NEEDS_YOU_REASONS)
        .nullable()
        .describe('Why it needs a person: behind on a publish, revoked, nothing published, or fallen back from a manifest that played nothing'),
      wakesAt: z.string().nullable().describe('Asleep: when it wakes'),
      filesMissing: z.number().nullable().describe('Updating: files still to fetch'),
    })
    .describe('What the screen is doing, as a fact. Unreachable while on the latest version is calm: the screen keeps playing it from its cache'),
  heartbeat: z
    .object({
      at: z.number(),
      playerVersion: z.string(),
      activeManifestId: z.string().nullable(),
      filesMissing: z.number(),
      fallbackFrom: z.string().nullable().describe('A newer manifest that played nothing, so the screen went back to its last good one'),
      displayOn: z.boolean(),
      clockTrusted: z.boolean(),
      driftMs: z.number(),
    })
    .nullable()
    .describe("The screen's last sync; null until it first syncs"),
  showing: z
    .object({
      asleep: z.boolean(),
      wakesAt: z.string().nullable(),
      playlist: z.object({ id: z.string(), name: z.string() }).nullable(),
      spot: z
        .object({
          id: z.string(),
          name: z.string(),
          kind: z.enum(['template', 'image', 'video', 'url']),
          template: z.string().nullable(),
          image: z.string().nullable().describe('SHA-256 of an image the spot shows, for a thumbnail (GET /api/blobs/:sha256)'),
        })
        .nullable()
        .describe("The playlist's first spot"),
      spots: z.number(),
    })
    .nullable()
    .describe('What the screen should be showing now, worked out from its desired manifest as the player does; null when nothing is published'),
  version: version.describe('Moves on when its name or settings change (not with heartbeats or publishes); pass it as ifVersion to update only what you read'),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ScreenView = z.infer<typeof screenOutput>;

/** A credential, without its hash. */
const credentialOutput = z.object({ id: z.string(), createdAt: z.number(), lastUsedAt: z.number().nullable(), revokedAt: z.number().nullable() });
export type CredentialView = z.infer<typeof credentialOutput>;

/** Manifests are immutable (their id is their hash), so a parsed one is kept for the life of the isolate. */
const MAX_CACHED_MANIFESTS = 64;
const manifests = new Map<string, ScreenManifest>();

async function loadManifest(blobs: R2Bucket, key: string): Promise<ScreenManifest | undefined> {
  const hit = manifests.get(key);
  if (hit) return hit;
  const obj = await blobs.get(key);
  if (!obj) return undefined;
  const m = await obj.json<ScreenManifest>();
  if (manifests.size >= MAX_CACHED_MANIFESTS) manifests.delete(manifests.keys().next().value!);
  manifests.set(key, m);
  return m;
}

const hoursOf = (s: Screen) => (s.displayHoursJson ? (JSON.parse(s.displayHoursJson) as DisplayHours) : null);

/** The override in force at `now`, or null once it has ended. */
export function liveOverride(json: string | null, now: number): DisplayOverride | null {
  if (!json) return null;
  const o = JSON.parse(json) as DisplayOverride;
  return Date.parse(o.until) > now ? o : null;
}

/**
 * A screen as tools return it. `credentials` are the screen's, when the caller has them already;
 * a screen whose every credential is revoked is revoked, while one that never collected a
 * credential is waiting to pair.
 */
export async function screenView(org: OrgScope, s: Screen, blobs: R2Bucket, now = Date.now(), credentials?: readonly ScreenCredential[]): Promise<ScreenView> {
  const creds = credentials ?? (await org.screens.credentials.forScreen(s.id));
  const revoked = s.status === 'revoked' || (creds.length > 0 && creds.every((c) => c.revokedAt != null));
  const hb = parseHeartbeat(s.heartbeatJson);
  const hours = hoursOf(s);
  const override = liveOverride(s.displayOverrideJson ?? null, now);
  let showing: ScreenView['showing'] = null;
  if (s.desiredManifestId) {
    const m = await loadManifest(blobs, manifestKey(s.orgId, s.id, s.desiredManifestId)).catch(() => undefined);
    try {
      showing = m ? shouldBeShowing(m, now, override) : null;
    } catch {
      // A manifest the player could not resolve either: the state says so when the screen reports it.
      showing = null;
    }
  }
  return {
    id: s.id,
    name: s.name,
    timezone: s.timezone,
    locale: s.locale,
    orientation: s.orientation,
    kind: s.kind,
    displayHours: hours,
    status: revoked ? 'revoked' : 'active',
    desiredManifestId: s.desiredManifestId,
    previousManifestId: s.previousManifestId,
    reportedManifestId: s.reportedManifestId,
    lastSeenAt: s.lastSeenAt,
    playerVersion: s.playerVersion,
    displayOverride: override,
    state: screenState(
      {
        status: revoked ? 'revoked' : 'active',
        timezone: s.timezone,
        displayHours: hours,
        desiredManifestId: s.desiredManifestId,
        reportedManifestId: s.reportedManifestId,
        lastSeenAt: s.lastSeenAt,
        heartbeat: hb,
      },
      now,
    ),
    heartbeat: hb
      ? {
          at: hb.at,
          playerVersion: hb.player.version,
          activeManifestId: hb.manifest.active ?? null,
          filesMissing: hb.manifest.filesMissing,
          fallbackFrom: hb.manifest.fallbackFrom ?? null,
          displayOn: hb.display.on,
          clockTrusted: hb.clock.trusted,
          driftMs: hb.driftMs,
        }
      : null,
    showing,
    version: s.rowVersion,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

const credentialView = (c: ScreenCredential): CredentialView => ({ id: c.id, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt, revokedAt: c.revokedAt });

async function requireScreen(org: OrgScope, screenId: string) {
  const row = await org.screens.get(screenId);
  if (!row) throw notFound('screen', screenId);
  return row;
}

/** The (redacted) input an audit row recorded. */
function inputOf(detailJson: string | null): Record<string, unknown> {
  try {
    const input = (JSON.parse(detailJson ?? '{}') as { input?: unknown }).input;
    return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** How many of a screen's events `get_screen` returns. */
const EVENTS = 20;

const listScreens = defineTool({
  name: 'list_screens',
  description:
    'List the screens in the organization with their settings, status and manifests, ordered by id, a page at a time. Returns { screens: Screen[], next }; pass next as cursor for the following page.',
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ ...pageInput }),
  output: z.object({ screens: z.array(screenOutput), next: nextOutput }),
  example: {},
  handler: async ({ org, input, blobs }) => {
    const [all, credentials] = await Promise.all([org.screens.list(), org.screens.credentials.list()]);
    const { rows, next } = page(all, (s) => [s.id], input);
    const now = Date.now();
    const of = (id: string) => credentials.filter((c) => c.screenId === id);
    return { screens: await Promise.all(rows.map((s) => screenView(org, s, blobs, now, of(s.id)))), next };
  },
});

const getScreen = defineTool({
  name: 'get_screen',
  description:
    'Get one screen by id: its settings, state, last heartbeat, what it should be showing, manifests, the ids of the groups it is in, its credentials (never their secrets) and its recent events (what was done to it, newest first). Returns { screen, groupIds, credentials, events }.',
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ screenId: id('screen') }),
  output: z.object({
    screen: screenOutput,
    groupIds: z.array(z.string()),
    credentials: z.array(credentialOutput),
    events: z.array(
      z.object({
        at: z.number(),
        action: z.string().describe('The tool that made the change'),
        actor: z.object({ kind: z.string(), id: z.string() }),
        input: z.record(z.string(), z.unknown()).describe('What the tool was given, secrets redacted'),
      }),
    ),
  }),
  example: { screenId: 'scr_example' },
  handler: async ({ org, input, blobs }) => {
    const screen = await requireScreen(org, input.screenId);
    const [groupIds, credentials, audit, view] = await Promise.all([
      org.screens.groupsOf(screen.id),
      org.screens.credentials.forScreen(screen.id),
      org.auditLog.list({ target: { kind: 'screen', id: screen.id }, limit: EVENTS }),
      screenView(org, screen, blobs),
    ]);
    const events = audit.map((e) => ({ at: e.at, action: e.action, actor: { kind: e.actorKind, id: e.actorId }, input: inputOf(e.detailJson) }));
    return { screen: view, groupIds, credentials: credentials.map(credentialView), events };
  },
});

const renameScreen = defineTool({
  name: 'rename_screen',
  description:
    'Rename a screen. The name is what people see in the CMS; screens do not show it. Pass the version you read as ifVersion so a change made since is not overwritten. Returns { screen }.',
  scope: 'screens:manage',
  minRole: 'editor',
  mutates: true,
  input: z.object({ screenId: id('screen'), name: name('screen'), ifVersion }),
  output: z.object({ screen: screenOutput }),
  example: { screenId: 'scr_example', name: 'Lobby' },
  target: (input) => ({ kind: 'screen', id: input.screenId }),
  handler: async ({ org, input, write, blobs }) => {
    const screen = await requireScreen(org, input.screenId);
    return { screen: await screenView(org, write(org.screens.stage.update(screen, { name: input.name }, input.ifVersion)), blobs) };
  },
});

const updateScreenSettings = defineTool({
  name: 'update_screen_settings',
  description:
    "Change a screen's time zone, locale, orientation or display hours. Give only the fields to change; null clears locale (the player's default) or display hours (always on). Display hours are checked as the player checks them. The screen picks the change up with the next publish to it. Pass the version you read as ifVersion so a change made since is not overwritten. Returns { screen }.",
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
      ifVersion,
    })
    .refine(
      (v) => v.timezone !== undefined || v.locale !== undefined || v.orientation !== undefined || v.displayHours !== undefined,
      'give at least one setting to change',
    ),
  output: z.object({ screen: screenOutput }),
  example: { screenId: 'scr_example', timezone: 'Europe/London', displayHours: { weekly: [{ days: [1, 2, 3, 4, 5], from: '07:00', to: '22:00' }] } },
  target: (input) => ({ kind: 'screen', id: input.screenId }),
  handler: async ({ org, input, write, blobs }) => {
    const screen = await requireScreen(org, input.screenId);
    const row = write(
      org.screens.stage.update(
        screen,
        {
          timezone: input.timezone,
          locale: input.locale,
          orientation: input.orientation,
          displayHoursJson: input.displayHours === undefined ? undefined : input.displayHours === null ? null : JSON.stringify(input.displayHours),
        },
        input.ifVersion,
      ),
    );
    return { screen: await screenView(org, row, blobs) };
  },
});

const setDisplayOverride = defineTool({
  name: 'set_display_override',
  description: `Wake a screen's display now ('on'), put it to sleep now ('off'), or go back to its display hours (null), for someone standing at the screen. The override lasts until the screen's next scheduled display change, and at most ${OVERRIDE_LIMIT_MS / 3_600_000} hours (the limit alone on a screen without display hours), then ends by itself. The screen gets it at once over its socket, or at its next sync. Returns { screen }.`,
  scope: 'screens:manage',
  minRole: 'editor',
  mutates: true,
  input: z.object({ screenId: id('screen'), state: z.enum(['on', 'off']).nullable().describe('on, off, or null to follow the display hours again') }),
  output: z.object({ screen: screenOutput }),
  example: { screenId: 'scr_example', state: 'on' },
  target: (input) => ({ kind: 'screen', id: input.screenId }),
  handler: async ({ org, input, write, notify, blobs }) => {
    const screen = await requireScreen(org, input.screenId);
    const now = Date.now();
    let override: DisplayOverride | null = null;
    if (input.state) {
      const change = nextDisplayChange(hoursOf(screen) ?? undefined, screen.timezone, new Date(now));
      const until = Math.min(change?.getTime() ?? Number.POSITIVE_INFINITY, now + OVERRIDE_LIMIT_MS);
      override = { state: input.state, until: new Date(until).toISOString() };
    }
    const row = write(org.screens.stage.update(screen, { displayOverrideJson: override ? JSON.stringify(override) : null }));
    notify((screens) => screens.command(screen.id, { type: 'display', override }));
    return { screen: await screenView(org, row, blobs, now) };
  },
});

const identifyScreen = defineTool({
  name: 'identify_screen',
  description: `Show the screen's name over its content for ${IDENTIFY_SECONDS} seconds, so someone in the room can tell which screen it is. Reaches a screen whose socket is open; one that is unreachable does not get it. Returns { screenId, seconds }.`,
  scope: 'screens:manage',
  minRole: 'editor',
  mutates: true,
  alwaysAudited: true,
  input: z.object({ screenId: id('screen') }),
  output: z.object({ screenId: z.string(), seconds: z.number() }),
  example: { screenId: 'scr_example' },
  target: (input) => ({ kind: 'screen', id: input.screenId }),
  handler: async ({ org, input, notify }) => {
    const screen = await requireScreen(org, input.screenId);
    notify((screens) => screens.command(screen.id, { type: 'identify', name: screen.name, seconds: IDENTIFY_SECONDS }));
    return { screenId: screen.id, seconds: IDENTIFY_SECONDS };
  },
});

const restartScreen = defineTool({
  name: 'restart_screen',
  description:
    "Restart the screen's player now: it reloads, plays from its cache at once and syncs. Use it when a screen looks stuck. Reaches a screen whose socket is open. Rebooting the device is not available yet. Returns { screenId }.",
  scope: 'screens:manage',
  minRole: 'editor',
  mutates: true,
  alwaysAudited: true,
  input: z.object({ screenId: id('screen') }),
  output: z.object({ screenId: z.string() }),
  example: { screenId: 'scr_example' },
  target: (input) => ({ kind: 'screen', id: input.screenId }),
  handler: async ({ org, input, notify }) => {
    const screen = await requireScreen(org, input.screenId);
    notify((screens) => screens.command(screen.id, { type: 'restart' }));
    return { screenId: screen.id };
  },
});

const revokeScreenCredential = defineTool({
  name: 'revoke_screen_credential',
  description:
    "Revoke one of a screen's credentials, so a device holding it can no longer fetch anything; its open socket is closed. Use get_screen to see the credentials. Revoking an already revoked credential changes nothing in the database but closes any socket still open with it. Owners only. Returns { credential }.",
  scope: 'screens:manage',
  minRole: 'owner',
  mutates: true,
  // A repeat stages nothing but still closes the socket, in case the first notice never arrived.
  alwaysAudited: true,
  input: z.object({ screenId: id('screen'), credentialId: id('credential') }),
  output: z.object({ credential: credentialOutput }),
  example: { screenId: 'scr_example', credentialId: 'crd_example' },
  target: (input) => ({ kind: 'credential', id: input.credentialId }),
  handler: async ({ org, input, write, notify }) => {
    const cred = await org.screens.credentials.get(input.credentialId);
    if (!cred || cred.screenId !== input.screenId) throw notFound('credential', input.credentialId);
    // A socket the device opened with it closes now, not when it next reconnects.
    notify((screens) => screens.revoked(cred.screenId, cred.id));
    if (cred.revokedAt != null) return { credential: credentialView(cred) };
    const row = write(org.screens.credentials.stage.update(cred, { revokedAt: Date.now() }));
    return { credential: credentialView(row) };
  },
});

export const screenTools = [
  listScreens,
  getScreen,
  renameScreen,
  updateScreenSettings,
  setDisplayOverride,
  identifyScreen,
  restartScreen,
  revokeScreenCredential,
];
