import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '~/lib/utils';

/**
 * The one "selected" look (#373): a tint with the primary edge, the same for a toggle button
 * (`aria-pressed`) and for a card around a radio or checkbox (`has-checked`). Not selected, an
 * outline on the card; hover only shades it (never a disabled one), so it never looks chosen, and never a
 * selected one, which keeps its tint (#416).
 * `stage` is the same look on a screen's dark surround, from the stage tokens; not selected, its
 * edge is transparent.
 *
 * Without colour: under forced colors the selected edge is thicker, so it still differs from the
 * rest. Focus is a full-strength ring (3:1 on a card, the canvas and the stage) over a transparent
 * outline, which forced colors paints, so focus shows there too. Callers add size and radius.
 */
export const choiceVariants = cva(
  'border focus-visible:outline-hidden focus-visible:ring-3 has-focus-visible:outline-2 has-focus-visible:outline-transparent has-focus-visible:ring-3 forced-colors:aria-pressed:border-4 forced-colors:has-checked:border-4',
  {
    variants: {
      tone: {
        default:
          'border-border-strong bg-card text-foreground hover:not-disabled:not-has-disabled:not-aria-pressed:not-has-checked:bg-muted focus-visible:ring-ring has-focus-visible:ring-ring aria-pressed:border-primary aria-pressed:bg-accent aria-pressed:text-accent-foreground has-checked:border-primary has-checked:bg-accent has-checked:text-accent-foreground',
        stage:
          'border-transparent text-stage-muted-foreground hover:not-disabled:text-stage-foreground focus-visible:ring-stage-ring aria-pressed:border-stage-ring aria-pressed:bg-stage-ring/20 aria-pressed:text-stage-foreground',
      },
    },
    defaultVariants: { tone: 'default' },
  },
);

/** A toggle button: `selected` is its pressed state, which is also what draws it. */
export function Choice({
  selected,
  tone,
  className,
  ...props
}: Omit<ComponentProps<'button'>, 'aria-pressed'> & VariantProps<typeof choiceVariants> & { selected: boolean }) {
  return <button type="button" data-slot="choice" aria-pressed={selected} className={cn(choiceVariants({ tone }), className)} {...props} />;
}
