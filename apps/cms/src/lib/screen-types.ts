/**
 * The screen tools' outputs as the CMS reads them (`list_screens`, `list_screen_status`, `get_screen`, `list_groups` in
 * packages/tools). Kept as types here so the CMS bundle does not pull in the tools package; the
 * tools' output schemas are the source of truth.
 */
export const STATE_KINDS = ['online', 'updating', 'asleep', 'unreachable', 'needs_you'] as const;
export type StateKind = (typeof STATE_KINDS)[number];

/** Whether a value read from a URL or a select is one of the states. */
export const isStateKind = (v: unknown): v is StateKind => STATE_KINDS.some((k) => k === v);

/** Whether a value read from a select is an orientation. */
export const isOrientation = (v: unknown): v is 'landscape' | 'portrait' => v === 'landscape' || v === 'portrait';
type NeedsYouReason = 'revoked' | 'behind' | 'nothing_published' | 'fallback';

interface DisplayWindow {
  from: string;
  to: string;
}
export interface DisplayHours {
  weekly: (DisplayWindow & { days: number[] })[];
  exceptions?: { date: string; on: DisplayWindow[] }[];
}
interface DisplayOverride {
  state: 'on' | 'off';
  until: string;
}

export interface ScreenView {
  id: string;
  name: string;
  timezone: string;
  locale: string | null;
  orientation: 'landscape' | 'portrait';
  /** A browser screen is a test screen: the player in a browser tab (M3-41). */
  kind: 'device' | 'browser';
  displayHours: DisplayHours | null;
  status: 'active' | 'revoked';
  desiredManifestId: string | null;
  previousManifestId: string | null;
  reportedManifestId: string | null;
  lastSeenAt: number | null;
  playerVersion: string | null;
  displayOverride: DisplayOverride | null;
  state: { kind: StateKind; reason: NeedsYouReason | null; wakesAt: string | null; filesMissing: number | null };
  heartbeat: {
    at: number;
    playerVersion: string;
    activeManifestId: string | null;
    filesMissing: number;
    fallbackFrom: string | null;
    displayOn: boolean;
    clockTrusted: boolean;
    driftMs: number;
  } | null;
  showing: {
    asleep: boolean;
    wakesAt: string | null;
    playlist: { id: string; name: string } | null;
    /** Whether a takeover plays that playlist. */
    takeover: boolean;
    spot: { id: string; name: string; kind: 'template' | 'image' | 'video' | 'url'; template: string | null; image: string | null } | null;
    spots: number;
  } | null;
  /** Moves on with every change to its name or settings; sent back as `ifVersion` so an edit cannot overwrite a newer one. */
  version: number;
  createdAt: number;
  updatedAt: number;
}

/** What `list_screen_status` gives of a screen: what it is doing, for the Screens page's poll. */
export type ScreenStatus = Pick<ScreenView, 'id' | 'state' | 'lastSeenAt' | 'desiredManifestId' | 'reportedManifestId'>;

export interface GroupView {
  id: string;
  name: string;
  screenIds: string[];
}

interface CredentialView {
  id: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

interface ScreenEvent {
  at: number;
  action: string;
  actor: { kind: string; id: string };
  /** What the tool was given, secrets redacted. */
  input: { [key: string]: Json };
}

/** A JSON value: what a server function may return. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface ScreenDetail {
  screen: ScreenView;
  groupIds: string[];
  credentials: CredentialView[];
  events: ScreenEvent[];
}
