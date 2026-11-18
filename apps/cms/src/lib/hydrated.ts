import { useSyncExternalStore } from 'react';

const noSubscription = () => () => {};

/** False while the server's HTML is being hydrated, true once React owns the page. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
}
