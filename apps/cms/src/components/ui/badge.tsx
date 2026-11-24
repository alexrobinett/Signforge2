import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '~/lib/utils';

/**
 * A short word on a tint (#372): a screen's state, the agent's marks, a caution, or a plain fact in
 * an outline. Every pill in the CMS is this; each tint's word is 4.5:1 on it (test/tokens.test.ts).
 */
const badgeVariants = cva('inline-flex items-center gap-1.5 rounded-full whitespace-nowrap', {
  variants: {
    variant: {
      online: 'bg-status-online-muted text-status-online-foreground',
      updating: 'bg-status-updating-muted text-status-updating-foreground',
      asleep: 'bg-status-asleep-muted text-status-asleep-foreground',
      offline: 'bg-status-offline-muted text-status-offline-foreground',
      'needs-you': 'bg-status-needs-you-muted text-status-needs-you-foreground',
      agent: 'bg-actor-agent-muted text-actor-agent',
      outline: 'border text-muted-foreground',
      // A mark on a screen's dark frame, such as its ratio.
      stage: 'bg-stage/85 text-stage-foreground',
    },
    size: {
      default: 'px-2 py-0.5 text-xs font-medium',
      // A screen's state, beside its name or on its thumbnail: a glyph, then the word.
      lg: 'py-0.5 pr-2.5 pl-2 text-meta font-semibold',
    },
  },
  defaultVariants: { variant: 'outline', size: 'default' },
});

export function Badge({ className, variant, size, ...props }: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant, size }), className)} {...props} />;
}
