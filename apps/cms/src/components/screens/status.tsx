/**
 * Status as shape, colour and word (docs/research/cms-ux.md, idea 4): online a filled circle,
 * updating a circle with an arc, asleep a half circle, offline a hollow circle, needs you a
 * triangle. The shape comes before the word, and the word is always there.
 */
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

const PILL: Record<Tone, string> = {
  online: 'bg-status-online-muted text-status-online-foreground',
  updating: 'bg-status-updating-muted text-status-updating-foreground',
  asleep: 'bg-status-asleep-muted text-status-asleep-foreground',
  offline: 'bg-status-offline-muted text-status-offline-foreground',
  'needs-you': 'bg-status-needs-you-muted text-status-needs-you-foreground',
};

export const toneOf = (kind: StateKind): Tone => (kind === 'unreachable' ? 'offline' : kind === 'needs_you' ? 'needs-you' : kind);

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
export function StatusPill({ tone, children, className }: { tone: Tone; children: string; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full py-0.5 pr-2.5 pl-2 text-[13px] font-semibold whitespace-nowrap', PILL[tone], className)}>
      <StatusGlyph tone={tone} />
      {children}
    </span>
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

/** A shape and a word, no pill: for a location's rollup. */
export function StatusWord({ tone, children }: { tone: Tone; children: string }) {
  const text: Record<Tone, string> = {
    online: 'text-status-online-foreground dark:text-status-online-foreground',
    updating: 'text-status-updating-foreground',
    asleep: 'text-status-asleep-foreground',
    offline: 'text-status-offline-foreground',
    'needs-you': 'text-status-needs-you-foreground',
  };
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[13px] font-semibold', text[tone])}>
      <StatusGlyph tone={tone} />
      {children}
    </span>
  );
}

export const KIND_WORD: Record<StateKind, string> = {
  online: 'Online',
  updating: 'Updating',
  asleep: 'Asleep',
  unreachable: 'Unreachable',
  needs_you: 'Needs you',
};
