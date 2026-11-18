/** Keeping a page live: re-reading its data, a ticking clock, and what the member may do. */
import { getRouteApi, useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

/** How often the Screens pages re-read their data while visible. */
export const REFRESH_MS = 15_000;

export function useLiveData(ms = REFRESH_MS) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void router.invalidate();
    }, ms);
    return () => clearInterval(t);
  }, [router, ms]);
}

/** The time the page reads from: the server's when its data came, then the browser's, every 10 s. */
export function useNow(at: number): number {
  const [now, setNow] = useState(at);
  // biome-ignore lint/correctness/useExhaustiveDependencies: new data (`at`) restarts the clock.
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, [at]);
  return now;
}

const app = getRouteApi('/_app');

/** The member's role in the active org. The API checks it again on every call. */
export function useRole() {
  return app.useLoaderData().organization?.role ?? 'viewer';
}

/** Editors and owners manage screens; viewers read. */
export const useCanManage = () => useRole() !== 'viewer';
