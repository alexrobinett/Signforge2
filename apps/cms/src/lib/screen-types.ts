/**
 * The screen tools' outputs as the CMS reads them (`list_screens`, `get_screen`, `list_groups` in
 * packages/tools). Kept as types here so the CMS bundle does not pull in the tools package; the
 * tools' output schemas are the source of truth.
 */
export type StateKind = 'online' | 'updating' | 'asleep' | 'unreachable' | 'needs_you';
export type NeedsYouReason = 'revoked' | 'behind' | 'nothing_published' | 'fallback';

export interface DisplayWindow {
  from: string;
  to: string;
}
export interface DisplayHours {
  weekly: (DisplayWindow & { days: number[] })[];
  exceptions?: { date: string; on: DisplayWindow[] }[];
}
export interface DisplayOverride {
  state: 'on' | 'off';
  until: string;
}

export interface ScreenView {
  id: string;
  name: string;
  timezone: string;
  locale: string | null;
  orientation: 'landscape' | 'portrait';
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
    spot: { id: string; name: string; kind: 'template' | 'image' | 'video' | 'url'; template: string | null; image: string | null } | null;
    spots: number;
  } | null;
  createdAt: number;
  updatedAt: number;
}

export interface GroupView {
  id: string;
  name: string;
  screenIds: string[];
}

export interface CredentialView {
  id: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface ScreenEvent {
  at: number;
  action: string;
  actor: { kind: string; id: string };
}

export interface ScreenDetail {
  screen: ScreenView;
  groupIds: string[];
  credentials: CredentialView[];
  events: ScreenEvent[];
}
