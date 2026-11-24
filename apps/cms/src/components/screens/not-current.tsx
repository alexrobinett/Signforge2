import { CloudOffIcon } from 'lucide-react';
import { ago } from '~/lib/screen-status';

/**
 * While the poll fails, the states on the page are the last ones heard, so it says so and since
 * when; the next good poll clears it. The live region stays in the accessibility tree while empty
 * (visually hidden, not `display: none`), so the notice is announced when it comes.
 */
export function NotCurrent({ failing, heardAt, now }: { failing: boolean; heardAt: number; now: number }) {
  return (
    <div role="status" className="empty:sr-only">
      {failing && (
        <p className="flex items-start gap-3 rounded-xl border bg-card px-4 py-3.5 text-base leading-normal">
          <CloudOffIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
          <span>
            <strong className="font-semibold">Status is not current.</strong> SignForge has not answered since{' '}
            {new Date(heardAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} ({ago(now - heardAt)} ago). This page keeps trying.
          </span>
        </p>
      )}
    </div>
  );
}
