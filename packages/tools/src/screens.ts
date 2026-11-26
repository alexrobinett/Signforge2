/** Screen tools: read screens, rename them or change their settings, send them a command (wake, sleep, identify, restart), revoke a credential. */
import type { DisplayHours, DisplayOverride, ScreenManifest } from '@signforge/contract';
import type { OrgScope, Screen, ScreenCredential } from '@signforge/db';
import { nextDisplayChange } from '@signforge/player-core';
import { z } from 'zod';
import { matches, systemLabels } from '@signforge/compiler/selector';
import { displayHours, id, ifVersion, locale, name, orientation, selector, timezone } from './fields';
import { labelsByScreen } from './labels';
import { parseHeartbeat } from './heartbeat';
import { keysetPage, page, pageInput } from './paging';
import { manifestKey } from './r2';
import { screenState, shouldBeShowing, type StateInput } from './screen-state';
import { unreachableAfterMs } from './settings';
import { defineTool, notFound, ToolError } from './tool';
import { outputs, type CredentialView, type ScreenView } from './outputs';

/** How long a display override lasts at most: on a screen without display hours, and over a closed weekend. */
export const OVERRIDE_LIMIT_MS = 12 * 3_600_000;
/** How long `screen_command`'s identify shows the screen's name. */
export const IDENTIFY_SECONDS = 10;

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

const hoursOf = (s: Pick<Screen, 'displayHoursJson'>) => (s.displayHoursJson ? (JSON.parse(s.displayHoursJson) as DisplayHours) : null);

type StateColumns = Pick<Screen, 'timezone' | 'displayHoursJson' | 'desiredManifestId' | 'reportedManifestId' | 'lastSeenAt'>;

/** What a screen's state is worked out from, given its row and whether it is revoked. */
export const stateInput = (s: StateColumns, revoked: boolean, heartbeat: StateInput['heartbeat'], unreachableAfterMs: number): StateInput => ({
  status: revoked ? 'revoked' : 'active',
  timezone: s.timezone,
  displayHours: hoursOf(s),
  desiredManifestId: s.desiredManifestId,
  reportedManifestId: s.reportedManifestId,
  lastSeenAt: s.lastSeenAt,
  heartbeat,
  unreachableAfterMs,
});

/** The override in force at `now`, or null once it has ended. */
export function liveOverride(json: string | null, now: number): DisplayOverride | null {
  if (!json) return null;
  const o = JSON.parse(json) as DisplayOverride;
  return Date.parse(o.until) > now ? o : null;
}

/** A screen is revoked once marked so, or once every credential it collected is revoked; one that never collected one is waiting to pair. */
const isRevoked = (s: Screen, creds: readonly ScreenCredential[]) => s.status === 'revoked' || (creds.length > 0 && creds.every((c) => c.revokedAt != null));

/**
 * A screen as tools return it. `credentials` and `labels` are the screen's, and `unreachableMs` the
 * org's threshold, when the caller has them already (a list reads each once); a screen whose every
 * credential is revoked is revoked, while one that never collected a credential is waiting to pair.
 */
export async function screenView(
  org: OrgScope,
  s: Screen,
  blobs: R2Bucket,
  now = Date.now(),
  credentials?: readonly ScreenCredential[],
  unreachableMs?: number,
  labels?: Readonly<Record<string, string>>,
): Promise<ScreenView> {
  const [creds, afterMs, own] = await Promise.all([
    credentials ?? org.screens.credentials.forScreen(s.id),
    unreachableMs ?? unreachableAfterMs(org),
    labels ?? org.screens.labels.list(s.id).then((rows) => labelsByScreen(rows).get(s.id) ?? {}),
  ]);
  const revoked = isRevoked(s, creds);
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
    labels: { ...own },
    systemLabels: systemLabels(s),
    status: revoked ? 'revoked' : 'active',
    desiredManifestId: s.desiredManifestId,
    previousManifestId: s.previousManifestId,
    reportedManifestId: s.reportedManifestId,
    lastSeenAt: s.lastSeenAt,
    playerVersion: s.playerVersion,
    displayOverride: override,
    state: screenState(stateInput(s, revoked, hb, afterMs), now),
    heartbeat: hb
      ? {
          at: hb.at,
          playerVersion: hb.player.version,
          activeManifestId: hb.manifest.active ?? null,
          filesMissing: hb.manifest.filesMissing,
          fallbackFrom: hb.manifest.fallbackFrom ?? null,
          displayOn: hb.display.on,
          displayOutput: hb.display.output ?? null,
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

/** A screen a command may go to: a revoked one plays nothing, and its socket is closed, so it is refused rather than reported sent. */
async function requireActiveScreen(org: OrgScope, screenId: string) {
  const screen = await requireScreen(org, screenId);
  if (isRevoked(screen, await org.screens.credentials.forScreen(screen.id)))
    throw new ToolError('conflict', `screen ${screenId} is revoked: pair it again to send it commands`);
  return screen;
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
    'List the screens in the organization with their settings, labels, status and manifests, ordered by id, a page at a time. Give a selector to list only the screens it matches, such as every north drive-thru ({ all: [{ key: "region", op: "eq", values: ["north"] }, { key: "type", op: "eq", values: ["drive-thru"] }] }) or every portrait screen ({ all: [{ key: "orientation", op: "eq", values: ["portrait"] }] }); list_label_keys says which keys and values exist. Returns { screens: Screen[], next }; pass next as cursor for the following page.',
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ selector: selector.optional().describe('Only the screens it matches; omit for every screen'), ...pageInput }),
  output: outputs.list_screens,
  example: { selector: { all: [{ key: 'orientation', op: 'eq', values: ['portrait'] }] } },
  handler: async ({ org, input, blobs }) => {
    const [all, credentials, afterMs, labelRows] = await Promise.all([
      org.screens.list(),
      org.screens.credentials.list(),
      unreachableAfterMs(org),
      org.screens.labels.list(),
    ]);
    const labels = labelsByScreen(labelRows);
    const of = (id: string) => labels.get(id) ?? {};
    const { selector: wanted } = input;
    const picked = wanted ? all.filter((s) => matches(wanted, { ...of(s.id), ...systemLabels(s) })) : all;
    const { rows, next } = page(picked, (s) => [s.id], input);
    const now = Date.now();
    const credentialsOf = (id: string) => credentials.filter((c) => c.screenId === id);
    return { screens: await Promise.all(rows.map((s) => screenView(org, s, blobs, now, credentialsOf(s.id), afterMs, of(s.id)))), next };
  },
});

const listScreenStatus = defineTool({
  name: 'list_screen_status',
  description:
    'List what each screen in the organization is doing, and only that: its state, when it was last heard from, the manifest it should play and the one it reports, ordered by id, a page at a time. For watching a fleet: it reads no settings or manifests, so it is cheaper than list_screens; use list_screens or get_screen for names, settings and what a screen should be showing. Returns { screens: ScreenStatus[], next }; pass next as cursor for the following page.',
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ ...pageInput }),
  output: outputs.list_screen_status,
  example: {},
  handler: async ({ org, input }) => {
    const [{ rows, next }, afterMs] = await Promise.all([
      keysetPage(
        input,
        (after, take) => org.screens.statusPage({ afterId: after === undefined ? undefined : String(after[0]), limit: take }),
        (s) => [s.id],
      ),
      unreachableAfterMs(org),
    ]);
    const now = Date.now();
    const screens = rows.map((s) => ({
      id: s.id,
      state: screenState(stateInput(s, s.status === 'revoked' || s.credentialsRevoked, parseHeartbeat(s.heartbeatJson), afterMs), now),
      lastSeenAt: s.lastSeenAt,
      desiredManifestId: s.desiredManifestId,
      reportedManifestId: s.reportedManifestId,
    }));
    return { screens, next };
  },
});

const getScreen = defineTool({
  name: 'get_screen',
  description:
    'Get one screen by id: its settings, labels, state, last heartbeat, what it should be showing, manifests, the publish whose version it fell back from if it fell back (null otherwise), the ids of the groups it is in, its credentials (never their secrets) and its recent events (what was done to it, newest first). Returns { screen, fallbackPublish, groupIds, credentials, events }.',
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ screenId: id('screen') }),
  output: outputs.get_screen,
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
    const fellBackFrom = view.heartbeat?.fallbackFrom;
    // When it first said so; a screen last synced before that was kept (#367) says so from its last heartbeat.
    const since = screen.fallbackSince ?? view.heartbeat?.at ?? Date.now();
    const fallbackPublish = (fellBackFrom && (await org.publishes.ofManifest(screen.id, fellBackFrom, since))) || null;
    return { screen: view, fallbackPublish, groupIds, credentials: credentials.map(credentialView), events };
  },
});

const updateScreen = defineTool({
  name: 'update_screen',
  description:
    'Change a screen: its name, which people see in the CMS and screens do not show, or its time zone, locale, orientation or display hours, which reach it with the next publish. Give only what changes; null clears locale or display hours. Pass the version you read as ifVersion. Returns { screen }.',
  scope: 'screens:manage',
  minRole: 'editor',
  mutates: true,
  // Strict: a field it does not take (a stray state, a group's name) is refused by name, not dropped.
  input: z
    .strictObject({
      screenId: id('screen'),
      name: name('screen').optional(),
      timezone: timezone.optional(),
      locale: locale.nullable().optional(),
      orientation: orientation.optional(),
      displayHours: displayHours.nullable().optional(),
      ifVersion,
    })
    .refine(
      (v) => v.name !== undefined || v.timezone !== undefined || v.locale !== undefined || v.orientation !== undefined || v.displayHours !== undefined,
      'give at least one of name, timezone, locale, orientation or displayHours to change',
    ),
  output: outputs.update_screen,
  example: { screenId: 'scr_example', name: 'Lobby', displayHours: { weekly: [{ days: [1, 2, 3, 4, 5], from: '07:00', to: '22:00' }] } },
  target: (input) => ({ kind: 'screen', id: input.screenId }),
  handler: async ({ org, input, write, blobs }) => {
    const screen = await requireScreen(org, input.screenId);
    const row = write(
      org.screens.stage.update(
        screen,
        {
          name: input.name,
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

/** What `screen_command` sends: a display override (on, off, or back to the display hours), identify, or restart. */
const SCREEN_COMMANDS = ['identify', 'restart', 'display_on', 'display_off', 'display_auto'] as const;

const screenCommand = defineTool({
  name: 'screen_command',
  description: `Act on a live screen now, for someone standing at it. identify shows its name over its content for ${IDENTIFY_SECONDS} seconds, so someone in the room can tell which screen it is. restart reloads its player, which plays from its cache at once and syncs: use it when a screen looks stuck (rebooting the device is not available yet). display_on wakes its display and display_off puts it to sleep, until its next scheduled display change and at most ${OVERRIDE_LIMIT_MS / 3_600_000} hours (the limit alone on a screen without display hours), then it follows its hours again; display_auto goes back to its display hours now. The screen gets it at once over its socket; an unreachable one misses identify and restart and gets a display change at its next sync. A revoked screen is refused identify and restart (conflict). Returns { screenId, command, displayOverride }.`,
  scope: 'screens:manage',
  minRole: 'editor',
  mutates: true,
  // Identify and restart act on the screen, not the database: audited though they stage nothing.
  alwaysAudited: true,
  input: z.strictObject({ screenId: id('screen'), command: z.enum(SCREEN_COMMANDS).describe('identify, restart, display_on, display_off or display_auto') }),
  output: outputs.screen_command,
  example: { screenId: 'scr_example', command: 'identify' },
  target: (input) => ({ kind: 'screen', id: input.screenId }),
  handler: async ({ org, input, write, notify }) => {
    const { command } = input;
    const now = Date.now();
    if (command === 'identify' || command === 'restart') {
      const screen = await requireActiveScreen(org, input.screenId);
      notify((screens) =>
        screens.command(screen.id, command === 'identify' ? { type: 'identify', name: screen.name, seconds: IDENTIFY_SECONDS } : { type: 'restart' }),
      );
      return { screenId: screen.id, command, displayOverride: liveOverride(screen.displayOverrideJson ?? null, now) };
    }
    const screen = await requireScreen(org, input.screenId);
    let override: DisplayOverride | null = null;
    if (command !== 'display_auto') {
      const change = nextDisplayChange(hoursOf(screen) ?? undefined, screen.timezone, new Date(now));
      const until = Math.min(change?.getTime() ?? Number.POSITIVE_INFINITY, now + OVERRIDE_LIMIT_MS);
      override = { state: command === 'display_on' ? 'on' : 'off', until: new Date(until).toISOString() };
    }
    write(org.screens.stage.update(screen, { displayOverrideJson: override ? JSON.stringify(override) : null }));
    notify((screens) => screens.command(screen.id, { type: 'display', override }));
    return { screenId: screen.id, command, displayOverride: override };
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
  output: outputs.revoke_screen_credential,
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

export const screenTools = [listScreens, listScreenStatus, getScreen, updateScreen, screenCommand, revokeScreenCredential];
