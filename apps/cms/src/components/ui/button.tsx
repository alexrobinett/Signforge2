import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import { type ComponentProps, cloneElement, isValidElement } from 'react';
import { cn } from '~/lib/utils';

export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-[color,background-color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-60 aria-disabled:opacity-60 aria-invalid:ring-destructive/30 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 disabled:bg-primary-disabled disabled:text-primary-disabled-foreground disabled:opacity-100 aria-disabled:bg-primary-disabled aria-disabled:text-primary-disabled-foreground aria-disabled:opacity-100',
        destructive: 'bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90',
        outline: 'border border-border-strong bg-card shadow-xs hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-4 py-2 has-[>svg]:px-3',
        xs: 'h-7 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5',
        sm: 'h-8 gap-1.5 px-3 has-[>svg]:px-2.5',
        lg: 'h-11 px-5 text-md has-[>svg]:px-4',
        icon: 'size-10',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild = false,
  children,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button';
  const said = variant ?? 'default';
  // A slotted child's own props win over the slot's, so its data-variant is set on the child itself.
  const child = asChild && isValidElement<Record<string, unknown>>(children) ? cloneElement(children, { 'data-variant': said }) : children;
  return (
    <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} data-variant={said}>
      {child}
    </Comp>
  );
}
