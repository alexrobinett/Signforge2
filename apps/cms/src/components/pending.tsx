/**
 * Between pages (#376): a thin bar at the top while the router waits on a navigation's loaders,
 * shown only past 300 ms (a CSS delay, so a quick page never flashes it), and the page's skeleton,
 * which the router shows in place of a page still loading past 300 ms (`defaultPendingMs`).
 */
import { useRouterState } from '@tanstack/react-router';

export function PendingBar() {
  const pending = useRouterState({ select: (s) => s.status === 'pending' });
  if (!pending) return null;
  return (
    <div role="progressbar" aria-label="Loading the page" className="fixed inset-x-0 top-0 z-50 h-1 overflow-hidden opacity-0 animate-pending-appear">
      <div className="h-full w-2/5 bg-primary animate-pending-slide" />
    </div>
  );
}

/** A page's title, its line, and a list of rows, drawn as blocks: most pages are a list. */
export function PageSkeleton() {
  return (
    <div aria-busy="true" className="space-y-6">
      <span role="status" className="sr-only">
        Loading…
      </span>
      <div aria-hidden className="space-y-2">
        <div className="h-8 w-48 animate-pulse rounded-md bg-muted" />
        <div className="h-4 w-full max-w-md animate-pulse rounded-md bg-muted" />
      </div>
      <ul aria-hidden className="divide-y overflow-hidden rounded-xl border bg-card">
        {[0, 1, 2, 3, 4].map((i) => (
          <li key={i} className="flex items-center gap-3 px-4 py-3">
            <div className="aspect-video w-16 flex-none animate-pulse rounded-md bg-muted" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-4 w-1/3 animate-pulse rounded-md bg-muted" />
              <div className="h-3 w-2/3 animate-pulse rounded-md bg-muted" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
