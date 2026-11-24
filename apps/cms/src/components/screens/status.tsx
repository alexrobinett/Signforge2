/**
 * Status as shape, colour and word (docs/research/cms-ux.md, idea 4): online a filled circle,
 * updating a circle with an arc, asleep a half circle, offline a hollow circle, needs you a
 * triangle. The shape comes before the word, and the word is always there.
 */
import { Badge } from '~/components/ui/badge';
import { describeScreen, type ScreenLike, type Tone } from '~/lib/screen-status';
import type { StateKind } from '~/lib/screen-types';
import { cn } from '~/lib/utils';

const GLYPH_COLOR: Record<Tone, string> = {
  online: 'text-status-online',
  updating: 'text-status-updating',
  asleep: 'text-status-asleep',
  offline: 'text-status-offline',
  'needs-you': 'text-status-needs-you',
};

export const toneOf = (kind: StateKind): Tone => (kind === 'unreachable' ? 'offline' : kind === 'needs_you' ? 'needs-you' : kind);

/** The state's shape in its colour, without the word: beside a name that is with its word. */
export function StatusGlyph({ tone, className }: { tone: Tone; className?: string }) {
  const c = cn('size-3 flex-none', GLYPH_COLOR[tone], className);
  switch (tone) {
    case 'online':
      return (
        <svg viewBox="0 0 12 12" className={c} aria-hidden>
          <circle cx="6" cy="6" r="5" fill="currentColor" />
        </svg>
      );
    case 'updating':
      return (
        <svg viewBox="0 0 12 12" className={c} aria-hidden>
          <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.5" />
          <path d="M6 1.5a4.5 4.5 0 0 1 4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          <circle cx="6" cy="6" r="1.6" fill="currentColor" />
        </svg>
      );
    case 'asleep':
      return (
        <svg viewBox="0 0 12 12" className={c} aria-hidden>
          <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 1.5a4.5 4.5 0 0 0 0 9z" fill="currentColor" />
        </svg>
      );
    case 'offline':
      return (
        <svg viewBox="0 0 12 12" className={c} aria-hidden>
          <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      );
    case 'needs-you':
      return (
        <svg viewBox="0 0 12 12" className={c} aria-hidden>
          <path d="M6 1l5.2 9.5H.8z" fill="currentColor" />
          <path d="M6 4.6v2.6" stroke="var(--card)" strokeWidth="1.4" strokeLinecap="round" />
          <circle cx="6" cy="8.9" r="0.8" fill="var(--card)" />
        </svg>
      );
  }
}

/** The pill: shape and word on the state's own tint. */
function StatusPill({ tone, children, className }: { tone: Tone; children: string; className?: string }) {
  return (
    <Badge variant={tone} size="lg" className={className}>
      <StatusGlyph tone={tone} />
      {children}
    </Badge>
  );
}

export function ScreenStatus({ screen, now, className }: { screen: ScreenLike; now: number; className?: string }) {
  const d = describeScreen(screen, now);
  return (
    <StatusPill tone={d.tone} className={className}>
      {d.word}
    </StatusPill>
  );
}

export const KIND_WORD: Record<StateKind, string> = {
  online: 'Online',
  updating: 'Updating',
  asleep: 'Asleep',
  unreachable: 'Unreachable',
  needs_you: 'Needs you',
};
