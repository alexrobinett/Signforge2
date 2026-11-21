/**
 * A screen's state in words, as the Screens pages show it (docs/research/cms-ux.md, ideas 3 and 4):
 * a fact the person can act on, with its own tone and shape, never colour alone. The state itself
 * is worked out on the server (`list_screens`); this only words it.
 */
import type { ScreenView, StateKind } from './screen-types';

export type Tone = 'online' | 'updating' | 'asleep' | 'offline' | 'needs-you';

export type ScreenLike = Pick<ScreenView, 'timezone' | 'lastSeenAt' | 'state' | 'showing'>;

export interface Described {
  tone: Tone;
  /** The pill: a word or two. */
  word: string;
  /** What it is doing, in a sentence. */
  line: string;
}

const TONE: Record<StateKind, Tone> = { online: 'online', updating: 'updating', asleep: 'asleep', unreachable: 'offline', needs_you: 'needs-you' };

/** "2 h", "14 min", "40 s": how long ago, short. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

/** A time in the screen's zone: "07:00" today there, "Thu 07:00" on another day. */
export function localClock(iso: string, timezone: string, now: number): string {
  const at = new Date(iso);
  const day = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: timezone });
  const time = at.toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  if (day(at) === day(new Date(now))) return time;
  return `${at.toLocaleDateString('en-GB', { timeZone: timezone, weekday: 'short' })} ${time}`;
}

const playing = (s: ScreenLike) => s.showing?.spot?.name;

export function describeScreen(s: ScreenLike, now: number): Described {
  const tone = TONE[s.state.kind];
  switch (s.state.kind) {
    case 'online': {
      const spot = playing(s);
      return { tone, word: 'Online', line: spot ? `Playing ${spot} · as scheduled` : 'Playing as scheduled' };
    }
    case 'updating': {
      const n = s.state.filesMissing;
      const left = n ? `, ${n} ${n === 1 ? 'file' : 'files'} to go` : '';
      return { tone, word: 'Updating', line: `Fetching the new version${left} · still playing the last one` };
    }
    case 'asleep': {
      const wakes = s.state.wakesAt ? ` · wakes ${localClock(s.state.wakesAt, s.timezone, now)}` : '';
      return { tone, word: `Asleep${wakes}`, line: 'Asleep on purpose, for its display hours' };
    }
    case 'unreachable': {
      if (s.lastSeenAt == null) return { tone, word: 'Not heard from yet', line: 'Paired, and not heard from yet. It syncs within a minute of starting.' };
      const word = `Unreachable ${ago(now - s.lastSeenAt)}`;
      const spot = playing(s);
      return { tone, word, line: spot ? `${word} · still playing ${spot}` : `${word} · still playing the latest version` };
    }
    case 'needs_you':
      return { tone, word: 'Needs you', line: NEEDS_YOU[s.state.reason ?? 'behind'] };
  }
}

const NEEDS_YOU: Record<NonNullable<ScreenView['state']['reason']>, string> = {
  behind: 'Unreachable and behind: it missed the latest publish, and plays an older version from its cache',
  revoked: 'Its credential was revoked, so it plays nothing. Pair it again to bring it back',
  nothing_published: 'Nothing is published to it yet',
  fallback: 'The latest version played nothing, so it went back to the one before',
};

/**
 * Whether a screen is retired: every credential it had is revoked. It plays nothing until paired
 * again, so the Screens page leaves it out of its list, its counts and the group pickers, and its
 * Retired filter shows it. From the state, which the poll keeps current.
 */
export const isRetired = (s: { state: Pick<ScreenView['state'], 'kind' | 'reason'> }) => s.state.kind === 'needs_you' && s.state.reason === 'revoked';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The line under the Screens heading. */
export function summarise(screens: readonly { state: { kind: StateKind } }[]): string {
  const count = (...kinds: StateKind[]) => screens.filter((s) => kinds.includes(s.state.kind)).length;
  const parts = [plural(screens.length, 'screen'), `${count('online', 'updating', 'unreachable')} playing now`];
  const asleep = count('asleep');
  if (asleep) parts.push(`${asleep} asleep on purpose`);
  const away = count('unreachable');
  if (away) parts.push(`${away} unreachable, still playing`);
  const needs = count('needs_you');
  if (needs) parts.push(`${needs} ${needs === 1 ? 'needs' : 'need'} you`);
  return parts.join(' · ');
}
