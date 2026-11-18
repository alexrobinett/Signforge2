import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { StoreProvider } from './state/provider';
import { createAppStore } from './state/store';

/** Called once per request on the server and once per page in the browser, so each gets its own store. */
export function getRouter() {
  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
    // biome-ignore lint/correctness/noComponentHookFactories: made once per router, so its identity never changes and nothing remounts.
    Wrap: ({ children }) => <StoreProvider store={store}>{children}</StoreProvider>,
  });
  const store = createAppStore({ router });
  return router;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
