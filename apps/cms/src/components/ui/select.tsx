/** A native select on the field tokens: every platform's own picker, which a phone needs, with a 3:1 edge. */
import { ChevronDownIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '~/lib/utils';

export function NativeSelect({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <span className={cn('relative inline-flex', className)}>
      <select
        data-slot="select"
        className="h-10 w-full appearance-none rounded-lg border border-input bg-card py-2 pr-9 pl-3 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60 aria-disabled:opacity-60 aria-invalid:border-destructive md:text-sm"
        {...props}
      >
        {children}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
    </span>
  );
}
