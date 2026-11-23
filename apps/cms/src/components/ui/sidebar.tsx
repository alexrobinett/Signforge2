/**
 * The parts of shadcn's sidebar the app frame uses, in its collapsible-to-icons mode: a nav item
 * that shows only its icon when the sidebar is folded, named by its label and a tooltip. Whether it
 * is folded comes from the store (src/state/ui.ts), not the component's own state, and the phone
 * drawer is the app's Sheet, so shadcn's provider, mobile hook and keyboard listener are left out.
 */
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip';
import { cn } from '~/lib/utils';

export function SidebarMenuButton({
  folded,
  tooltip,
  className,
  ...props
}: ComponentProps<typeof Slot.Root> & {
  /** Only the icon shows; the label is the tooltip, and stays the name. */
  folded: boolean;
  tooltip: string;
}) {
  const button = (
    <Slot.Root
      data-slot="sidebar-menu-button"
      className={cn(
        'flex h-10 items-center gap-3 overflow-hidden rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[status=active]:bg-accent data-[status=active]:text-accent-foreground [&>svg]:size-4.5 [&>svg]:shrink-0',
        folded && 'w-10 justify-center px-0 [&>span]:sr-only',
        className,
      )}
      {...props}
    />
  );
  // Always in its tooltip, shown only when folded: the button stays the same element, so it keeps focus as it folds.
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right" hidden={!folded}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
