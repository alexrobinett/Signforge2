import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '~/lib/utils';

/**
 * The one "selected" look (#373): a tint with the primary edge, the same for a toggle button
 * (`aria-pressed`) and for a card around a radio or checkbox (`has-checked`). Not selected, an
 * outline on the card; hover only shades it, so it never looks chosen. `stage` is the same look
 * on a screen's dark surround, from the stage tokens. Callers add size and radius.
 */
export const choiceVariants = cva('border outline-none focus-visible:ring-[3px] has-focus-visible:ring-[3px]', {
  variants: {
    tone: {
      default:
        'border-border-strong bg-card text-foreground hover:bg-muted focus-visible:ring-ring/50 has-focus-visible:ring-ring/50 aria-pressed:border-primary aria-pressed:bg-accent aria-pressed:text-accent-foreground has-checked:border-primary has-checked:bg-accent has-checked:text-accent-foreground',
      stage:
        'border-transparent text-stage-muted-foreground hover:text-stage-foreground focus-visible:ring-stage-ring aria-pressed:border-stage-ring aria-pressed:bg-stage-ring/20 aria-pressed:text-stage-foreground',
    },
  },
  defaultVariants: { tone: 'default' },
});

/** A toggle button: `selected` is its pressed state, which is also what draws it. */
export function Choice({
  selected,
  tone,
  className,
  ...props
}: Omit<ComponentProps<'button'>, 'aria-pressed'> & VariantProps<typeof choiceVariants> & { selected: boolean }) {
  return <button type="button" data-slot="choice" aria-pressed={selected} className={cn(choiceVariants({ tone }), className)} {...props} />;
}
