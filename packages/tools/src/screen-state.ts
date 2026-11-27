/**
 * A screen's state as the CMS shows it: a fact a person can act on, never colour alone
 * (docs/research/cms-ux.md, ideas 2 to 4). Offline is calm while the screen is on the latest
 * version, because it keeps playing it from its cache; "needs you" is kept for screens that need a
 * person: behind on a publish, revoked, nothing published, or fallen back from a manifest that
 * played nothing.
 */
import type { DisplayHours, DisplayOverride, ScreenManifest, Spot } from '@signforge/contract';
import { activeTakeover, displayOn, localTime, nextDisplayChange, resolvePlaylist } from '@signforge/player-core';
import type { ScreenHeartbeat } from './heartbeat';

/**
 * By default, a screen not heard from for this long is unreachable (the org can change it, M3-42). It syncs every 5 minutes, every 2 while
 * its socket is down, so this is three missed syncs; it matches the default alert threshold (M3-42).
 */
export const UNREACHABLE_AFTER_MS = 15 * 60_000;

export const STATE_KINDS = ['online', 'updating', 'asleep', 'unreachable', 'needs_you'] as const;
export type StateKind = (typeof STATE_KINDS)[number];
export const NEEDS_YOU_REASONS = ['revoked', 'behind', 'nothing_published', 'fallback'] as const;
export type NeedsYouReason = (typeof NEEDS_YOU_REASONS)[number];

export interface ScreenState {
  kind: StateKind;
  /** Why it needs you; null for every other kind. */
  reason: NeedsYouReason | null;
  /** Asleep: when it wakes, by its display hours or the end of a "sleep now" override. Null if never. */
  wakesAt: string | null;
  /** Updating: files of the new manifest it has still to fetch. */
  filesMissing: number | null;
}

/** What the state is worked out from: the screen's row, its last heartbeat parsed. */
export interface StateInput {
  status: 'active' | 'revoked';
  timezone: string;
  displayHours: DisplayHours | null;
  desiredManifestId: string | null;
  reportedManifestId: string | null;
  lastSeenAt: number | null;
  heartbeat: ScreenHeartbeat | undefined;
  /** The org's threshold (`org_settings`), `UNREACHABLE_AFTER_MS` by default. */
  unreachableAfterMs: number;
}

const fact = (kind: StateKind, extra: Partial<ScreenState> = {}): ScreenState => ({ kind, reason: null, wakesAt: null, filesMissing: null, ...extra });
const needsYou = (reason: NeedsYouReason) => fact('needs_you', { reason });

export function screenState(s: StateInput, now: number): ScreenState {
  if (s.status === 'revoked') return needsYou('revoked');
  const hb = s.heartbeat;
  const playing = s.reportedManifestId ?? hb?.manifest.active ?? null;
  const behind = !!s.desiredManifestId && playing !== s.desiredManifestId;
  if (s.lastSeenAt == null || now - s.lastSeenAt > s.unreachableAfterMs) return behind ? needsYou('behind') : fact('unreachable');
  if (!s.desiredManifestId) return needsYou('nothing_published');
  if (hb?.manifest.fallbackFrom) return needsYou('fallback');
  if (hb && !hb.display.on) {
    const override = hb.display.override;
    const wakes = override?.state === 'off' ? new Date(override.until) : nextDisplayChange(s.displayHours ?? undefined, s.timezone, new Date(now));
    return fact('asleep', { wakesAt: wakes ? wakes.toISOString() : null });
  }
  if (behind || (hb?.manifest.filesMissing ?? 0) > 0) return fact('updating', { filesMissing: hb?.manifest.filesMissing ?? null });
  return fact('online');
}

/** What a screen should be showing at a moment, worked out as the player does from its manifest. */
export interface ShouldBeShowing {
  /** Outside its display hours, and not woken by an override. */
  asleep: boolean;
  wakesAt: string | null;
  playlist: { id: string; name: string } | null;
  /** Whether a takeover plays it. */
  takeover: boolean;
  /** The playlist's first spot: the loop's position on the screen is not known here. */
  spot: { id: string; name: string; kind: Spot['kind']; template: string | null; templateName: string | null; image: string | null } | null;
  /** How many spots the playlist plays. */
  spots: number;
}

/** An image the spot shows, for a thumbnail: its own file, or the first image a template spot uses. */
function imageOf(spot: Spot, m: ScreenManifest): string | null {
  if (spot.kind === 'image') return spot.file;
  if (spot.kind !== 'template') return null;
  return Object.values(spot.assets).find((sha) => m.files[sha]?.type.startsWith('image/')) ?? null;
}

export function shouldBeShowing(m: ScreenManifest, now: number, override?: DisplayOverride | null): ShouldBeShowing {
  const at = new Date(now);
  const hours = m.screen.displayHours;
  const live = override && Date.parse(override.until) > now ? override : null;
  const on = live ? live.state === 'on' : displayOn(hours, localTime(at, m.screen.timezone));
  if (!on) {
    const wakes = live ? new Date(live.until) : nextDisplayChange(hours, m.screen.timezone, at);
    return { asleep: true, wakesAt: wakes ? wakes.toISOString() : null, playlist: null, takeover: false, spot: null, spots: 0 };
  }
  const playlist = resolvePlaylist(m, at);
  const first = playlist.items.map((i) => m.spots[i.spot]).find((s): s is Spot => !!s);
  return {
    asleep: false,
    wakesAt: null,
    playlist: { id: playlist.id, name: playlist.name },
    takeover: activeTakeover(m, at) !== undefined,
    spot: first
      ? {
          id: first.id,
          name: first.name,
          kind: first.kind,
          template: first.kind === 'template' ? first.template : null,
          templateName: first.kind === 'template' ? (m.templates[first.template]?.manifest.name ?? null) : null,
          image: imageOf(first, m),
        }
      : null,
    spots: playlist.items.length,
  };
}
